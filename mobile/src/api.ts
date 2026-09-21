import AsyncStorage from '@react-native-async-storage/async-storage';
import { encryptLoginPassword } from './crypto/login-crypto';
import type {
  ApiEnvelope,
  EncryptionKeyInfo,
  LogStat,
  LoginChallenge,
  LoginResult,
  NewApiStatus,
  PageResult,
  SelfUser,
  TokenItem,
} from './types';

export type StoredSession = {
  baseUrl: string;
  access_token: string;
  access_expires_at: number;
  refresh_token?: string;
  session_id?: string;
  user?: SelfUser;
};

const SESSION_KEY = 'newapi.session.v1';
const PAGE_SIZE = 100;
const MAX_TOKEN_PAGES = 20;

/** 刷新令牌失效时抛出，界面据此回到登录页。 */
export class SessionExpiredError extends Error {
  constructor(message = '会话已过期，请重新登录') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

type RawResponse = {
  ok: boolean;
  status: number;
  data: ApiEnvelope<unknown>;
  headers: Record<string, string>;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** 与站点同源的 Origin，用于通过 new-api 的 SessionCookieOriginGuard 校验。 */
function originOf(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return baseUrl;
  }
}

function collectHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const headerList = headers as Headers;
  if (typeof headerList.forEach === 'function') {
    headerList.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value);
    });
  } else {
    const headerRecord = headers as Record<string, string>;
    Object.keys(headerRecord).forEach((key) => {
      out[key.toLowerCase()] = headerRecord[key];
    });
  }
  return out;
}

function getRefreshCookie(headers: Record<string, string>): string | undefined {
  const header = headers['set-cookie'] ?? '';
  const match = /new_api_refresh=([^;]+)/i.exec(header);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export async function loadSession(): Promise<StoredSession | null> {
  const raw = await AsyncStorage.getItem(SESSION_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export async function saveSession(session: StoredSession | null): Promise<void> {
  if (session) {
    await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } else {
    await AsyncStorage.removeItem(SESSION_KEY);
  }
}

export function formatQuota(quota: number, status: NewApiStatus | null): string {
  if (status && !status.display_in_currency) {
    return String(quota);
  }
  if (!status || !Number.isFinite(status.quota_per_unit) || status.quota_per_unit <= 0) {
    return String(quota);
  }

  const usd = quota / status.quota_per_unit;
  const type = (status.quota_display_type ?? 'USD').toUpperCase();

  if (type === 'TOKENS') {
    return String(quota);
  }
  if (type === 'CNY') {
    return `CNY ${usd * (status.usd_exchange_rate || 1)}`;
  }
  if (type === 'CUSTOM') {
    const symbol = status.custom_currency_symbol || '';
    const rate = status.custom_currency_exchange_rate || 1;
    return `${symbol}${usd * rate}`.trim();
  }
  return `$${usd}`;
}

export class NewApiClient {
  /** In-flight refresh, shared by every request that hits a 401 at the same time. */
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(private readonly baseUrlInput: string) {}

  private get baseUrl() {
    return normalizeBaseUrl(this.baseUrlInput);
  }

  private endpoint(path: string) {
    return `${this.baseUrl}${path}`;
  }

  private async rawRequest(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<RawResponse> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      // 让 new-api 的错误提示按中文返回（语言回退链：用户设置 -> 上下文 -> 请求头 -> 默认）
      'Accept-Language': 'zh-CN',
      ...(init.headers ?? {}),
    };
    const response = await fetch(this.endpoint(path), {
      method: init.method ?? 'GET',
      headers,
      body: init.body,
    });
    const responseHeaders = collectHeaders(response.headers);
    let data: ApiEnvelope<unknown> = { success: response.ok };
    try {
      data = (await response.json()) as ApiEnvelope<unknown>;
    } catch {
      data = { success: response.ok };
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      headers: responseHeaders,
    };
  }

  private async request<T>(
    path: string,
    init: Parameters<NewApiClient['rawRequest']>[1] = {},
  ): Promise<T> {
    const session = await loadSession();
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (session?.access_token) {
      headers.Authorization = `Bearer ${session.access_token}`;
    }

    let response = await this.rawRequest(path, { ...init, headers });
    if (response.status === 401 && session?.refresh_token) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        const nextSession = await loadSession();
        if (nextSession?.access_token) {
          headers.Authorization = `Bearer ${nextSession.access_token}`;
        }
        response = await this.rawRequest(path, { ...init, headers });
      }
      if (!refreshed || response.status === 401) {
        await saveSession(null);
        throw new SessionExpiredError();
      }
    }

    if (!response.data.success) {
      throw new Error(response.data.message || `请求失败 (${response.status})`);
    }
    return response.data.data as T;
  }

  private async tryRefresh(): Promise<boolean> {
    // new-api rotates the refresh cookie on every use, so parallel 401s must
    // not each redeem the same token; the losers would look like a dead session.
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh()
        .then(() => true)
        .catch(() => false)
        .finally(() => {
          this.refreshInFlight = null;
        });
    }
    return this.refreshInFlight;

  }

  getStatus(): Promise<NewApiStatus> {
    return this.request<NewApiStatus>('/api/status');
  }

  /** GET /api/user/login/encryption-key，站点未开启加密时 enabled 为 false。 */
  async getEncryptionKey(): Promise<EncryptionKeyInfo> {
    const response = await this.rawRequest('/api/user/login/encryption-key');
    if (!response.data.success) {
      throw new Error(response.data.message || '获取登录加密公钥失败');
    }
    return (response.data.data ?? { enabled: false }) as EncryptionKeyInfo;
  }

  async passwordLogin(username: string, password: string): Promise<LoginResult> {
    const status = await this.getStatus();
    if (!status.password_login_enabled) {
      throw new Error('该中转站未开放账号密码登录');
    }
    if (status.turnstile_check) {
      throw new Error('该中转站开启了 Cloudflare Turnstile 验证，第三方客户端无法完成登录');
    }

    const body: Record<string, string> = { username };
    if (status.password_login_encryption_enabled) {
      const key = await this.getEncryptionKey();
      if (!key.enabled || !key.kid || !key.public_key) {
        throw new Error('该中转站开启了登录密码加密，但未能获取公钥，请稍后重试');
      }
      const encrypted = encryptLoginPassword(password, { kid: key.kid, public_key: key.public_key });
      body.password_encrypted = encrypted.password_encrypted;
      body.encryption_key_id = encrypted.encryption_key_id;
    } else {
      body.password = password;
    }

    const login = await this.rawRequest('/api/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!login.data.success) {
      throw new Error(login.data.message || '登录失败');
    }

    const data = login.data.data as (LoginResult & Partial<LoginChallenge>) | undefined;
    if (!data || typeof data !== 'object') {
      throw new Error('登录响应异常，请稍后重试');
    }
    if (data.require_verification) {
      const available = (data.methods ?? []).filter((method) => method.available);
      const names = available.map((method) => method.method).join('、');
      throw new Error(
        `该账号开启了登录验证（${names || '2FA'}），请先在网页端完成验证流程，` +
          '当前版本暂不支持在应用内验证',
      );
    }
    if (!data.access_token) {
      throw new Error('登录响应缺少访问令牌，请稍后重试');
    }

    const refreshToken = getRefreshCookie(login.headers);
    await saveSession({
      baseUrl: this.baseUrl,
      access_token: data.access_token,
      access_expires_at: data.access_expires_at,
      refresh_token: refreshToken,
      session_id: data.session?.sid,
      user: data.user,
    });
    return data as LoginResult;
  }

  async refresh(): Promise<void> {
    const session = await loadSession();
    if (!session?.refresh_token) {
      throw new SessionExpiredError('缺少刷新令牌，请重新登录');
    }
    const response = await this.rawRequest('/api/user/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `new_api_refresh=${encodeURIComponent(session.refresh_token)}`,
        'X-Auth-Session': session.session_id ?? '',
        Origin: originOf(this.baseUrl),
      },
      body: '{}',
    });
    if (!response.data.success) {
      throw new SessionExpiredError(response.data.message || '刷新会话失败');
    }

    const data = response.data.data as LoginResult | undefined;
    if (!data?.access_token) {
      throw new SessionExpiredError('刷新响应缺少访问令牌');
    }
    const nextRefreshToken = getRefreshCookie(response.headers) ?? session.refresh_token;
    await saveSession({
      ...session,
      access_token: data.access_token,
      access_expires_at: data.access_expires_at,
      refresh_token: nextRefreshToken,
      session_id: data.session?.sid ?? session.session_id,
      user: data.user ?? session.user,
    });
  }

  /** 先通知服务端吊销会话，再清除本地会话。 */
  async logout(): Promise<void> {
    const session = await loadSession();
    if (session?.access_token) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        'X-Auth-Session': session.session_id ?? '',
        Origin: originOf(this.baseUrl),
      };
      if (session.refresh_token) {
        headers.Cookie = `new_api_refresh=${encodeURIComponent(session.refresh_token)}`;
      }
      try {
        await this.rawRequest('/api/user/auth/logout', {
          method: 'POST',
          headers,
          body: '{}',
        });
      } catch {
        // 服务端不可达时仍然清除本地会话
      }
    }
    await saveSession(null);
  }

  getSelf(): Promise<SelfUser> {
    return this.request<SelfUser>('/api/user/self');
  }

  /** 翻页拉全量令牌（服务端每页最多 100 条）。 */
  async getTokens(): Promise<TokenItem[]> {
    const items: TokenItem[] = [];
    for (let page = 1; page <= MAX_TOKEN_PAGES; page += 1) {
      const result = await this.request<PageResult<TokenItem>>(
        `/api/token/?p=${page}&page_size=${PAGE_SIZE}`,
      );
      const pageItems = result.items ?? [];
      items.push(...pageItems);
      const total = typeof result.total === 'number' ? result.total : items.length;
      if (pageItems.length < PAGE_SIZE || items.length >= total) {
        break;
      }
    }
    return items;
  }

  getSelfLogStat(): Promise<LogStat> {
    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 24 * 60 * 60;
    return this.request<LogStat>(
      `/api/log/self/stat?start_timestamp=${dayAgo}&end_timestamp=${now}`,
    );
  }
}
