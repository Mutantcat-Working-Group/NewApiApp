import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { encryptLoginPassword } from './crypto/login-crypto';
import type {
  ApiEnvelope,
  CheckinResult,
  CheckinStatus,
  EncryptionKeyInfo,
  GroupInfo,
  LogItem,
  LogStat,
  LoginChallenge,
  LoginResult,
  NewApiStatus,
  PageResult,
  QuotaDateItem,
  SelfUser,
  SubscriptionPlan,
  SubscriptionSelf,
  TokenPayload,
  TokenItem,
  TopUpInfo,
  TopUpItem,
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

/** Thrown when the refresh token is no longer accepted; the UI returns to the login screen. */
export class SessionExpiredError extends Error {
  constructor(message = 'Session expired, please sign in again') {
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

/** Same-origin Origin, required by new-api's SessionCookieOriginGuard. */
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

export function loadSession(): StoredSession | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession | null): void {
  if (session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(SESSION_KEY);
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
  const roundedUsd = usd.toFixed(2);
  if (type === 'CNY') {
    return `CNY ${(usd * (status.usd_exchange_rate || 1)).toFixed(2)}`;
  }
  if (type === 'CUSTOM') {
    const symbol = status.custom_currency_symbol || '';
    const rate = status.custom_currency_exchange_rate || 1;
    return `${symbol}${(usd * rate).toFixed(2)}`.trim();
  }
  return `$${roundedUsd}`;
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
      // Ask new-api to answer in Chinese (fallback chain: user setting -> context -> header -> default)
      'Accept-Language': 'zh-CN',
      ...(init.headers ?? {}),
    };
    const response = await tauriFetch(this.endpoint(path), {
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
    const session = loadSession();
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (session?.access_token) {
      headers.Authorization = `Bearer ${session.access_token}`;
    }

    let response = await this.rawRequest(path, { ...init, headers });
    if (response.status === 401 && session?.refresh_token) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        const nextSession = loadSession();
        if (nextSession?.access_token) {
          headers.Authorization = `Bearer ${nextSession.access_token}`;
        }
        response = await this.rawRequest(path, { ...init, headers });
      }
      if (!refreshed || response.status === 401) {
        saveSession(null);
        throw new SessionExpiredError();
      }
    }

    if (!response.data.success) {
      throw new Error(response.data.message || `Request failed (${response.status})`);
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

  /** GET /api/user/login/encryption-key; enabled is false when the site does not encrypt passwords. */
  async getEncryptionKey(): Promise<EncryptionKeyInfo> {
    const response = await this.rawRequest('/api/user/login/encryption-key');
    if (!response.data.success) {
      throw new Error(response.data.message || 'Failed to load the login encryption key');
    }
    return (response.data.data ?? { enabled: false }) as EncryptionKeyInfo;
  }

  async passwordLogin(username: string, password: string): Promise<LoginResult> {
    const status = await this.getStatus();
    if (!status.password_login_enabled) {
      throw new Error('This relay site does not allow username/password login');
    }
    if (status.turnstile_check) {
      throw new Error(
        'This relay site requires Cloudflare Turnstile, which third-party clients cannot complete',
      );
    }

    const body: Record<string, string> = { username };
    if (status.password_login_encryption_enabled) {
      const key = await this.getEncryptionKey();
      if (!key.enabled || !key.kid || !key.public_key) {
        throw new Error('Password encryption is on but the public key could not be loaded');
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
      throw new Error(login.data.message || 'Login failed');
    }

    const data = login.data.data as (LoginResult & Partial<LoginChallenge>) | undefined;
    if (!data || typeof data !== 'object') {
      throw new Error('Unexpected login response, please try again later');
    }
    if (data.require_verification) {
      const available = (data.methods ?? []).filter((method) => method.available);
      const names = available.map((method) => method.method).join(', ');
      throw new Error(
        `This account requires login verification (${names || '2FA'}); ` +
          'complete it on the website first, in-app verification is not supported yet',
      );
    }
    if (!data.access_token) {
      throw new Error('Login response is missing an access token, please try again later');
    }

    const refreshToken = getRefreshCookie(login.headers);
    saveSession({
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
    const session = loadSession();
    if (!session?.refresh_token) {
      throw new SessionExpiredError('Missing refresh token, please sign in again');
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
      throw new SessionExpiredError(response.data.message || 'Refresh failed');
    }

    const data = response.data.data as LoginResult | undefined;
    if (!data?.access_token) {
      throw new SessionExpiredError('Refresh response is missing an access token');
    }
    const nextRefreshToken = getRefreshCookie(response.headers) ?? session.refresh_token;
    saveSession({
      ...session,
      access_token: data.access_token,
      access_expires_at: data.access_expires_at,
      refresh_token: nextRefreshToken,
      session_id: data.session?.sid ?? session.session_id,
      user: data.user ?? session.user,
    });
  }

  /** Tells the server to revoke the session, then clears the local one. */
  async logout(): Promise<void> {
    const session = loadSession();
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
        // Clear the local session even when the server is unreachable
      }
    }
    saveSession(null);
  }

  getSelf(): Promise<SelfUser> {
    return this.request<SelfUser>('/api/user/self');
  }

  /** Pages through every token (the server caps a page at 100 items). */
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

  getNotice(): Promise<string> {
    return this.request<string>('/api/notice');
  }

  getGroups(): Promise<Record<string, GroupInfo>> {
    return this.request<Record<string, GroupInfo>>('/api/user/self/groups');
  }

  getUserModels(): Promise<string[]> {
    return this.request<string[]>('/api/user/models');
  }

  getQuotaDates(startTimestamp: number, endTimestamp: number): Promise<QuotaDateItem[]> {
    return this.request<QuotaDateItem[]>(
      `/api/data/self?start_timestamp=${startTimestamp}&end_timestamp=${endTimestamp}`,
    );
  }

  getUsageLogs(page = 1, pageSize = 30): Promise<PageResult<LogItem>> {
    return this.request<PageResult<LogItem>>(
      `/api/log/self?p=${page}&page_size=${pageSize}`,
    );
  }

  getTopUpInfo(): Promise<TopUpInfo> {
    return this.request<TopUpInfo>('/api/user/topup/info');
  }

  /** 兑换充值码，成功时返回入账额度（quota 单位）。 */
  redeemTopUpKey(key: string): Promise<number> {
    return this.request<number>('/api/user/topup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
  }

  getTopUpHistory(page = 1, pageSize = 20): Promise<PageResult<TopUpItem>> {
    return this.request<PageResult<TopUpItem>>(
      `/api/user/topup/self?p=${page}&page_size=${pageSize}`,
    );
  }

  getCheckinStatus(): Promise<CheckinStatus> {
    return this.request<CheckinStatus>('/api/user/checkin');
  }

  doCheckin(): Promise<CheckinResult> {
    return this.request<CheckinResult>('/api/user/checkin', { method: 'POST' });
  }

  getAffCode(): Promise<string> {
    return this.request<string>('/api/user/aff');
  }

  getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
    return this.request<SubscriptionPlan[]>('/api/subscription/plans');
  }

  getSubscriptionSelf(): Promise<SubscriptionSelf> {
    return this.request<SubscriptionSelf>('/api/subscription/self');
  }

  createToken(payload: TokenPayload): Promise<void> {
    return this.request<void>('/api/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  updateTokenStatus(id: number, status: number): Promise<void> {
    return this.request<void>('/api/token/?status_only=1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
  }

  deleteToken(id: number): Promise<void> {
    return this.request<void>(`/api/token/${id}`, { method: 'DELETE' });
  }

  getTokenKey(id: number): Promise<string> {
    return this.request<{ key: string }>(`/api/token/${id}/key`, { method: 'POST' }).then(
      (data) => data.key,
    );
  }
}
