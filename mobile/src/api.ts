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

type AccountStore = {
  version: 2;
  activeAccountId: string | null;
  accounts: Record<string, StoredSession>;
};

const LEGACY_SESSION_KEY = 'newapi.session.v1';
const ACCOUNTS_KEY = 'newapi.accounts.v2';
const PAGE_SIZE = 100;
const MAX_TOKEN_PAGES = 20;

/** 刷新令牌失效时抛出，界面据此回到登录页。 */
export class SessionExpiredError extends Error {
  constructor(message = '会话已过期，请重新登录') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/** 站点在密码步骤后要求 2FA 验证码时抛出，登录页据此切换到验证码步骤。 */
export class LoginVerificationRequiredError extends Error {
  readonly challenge: LoginChallenge;

  constructor(message: string, challenge: LoginChallenge) {
    super(message);
    this.name = 'LoginVerificationRequiredError';
    this.challenge = challenge;
  }
}

type RawResponse = {
  ok: boolean;
  status: number;
  data: ApiEnvelope<unknown>;
  headers: Record<string, string>;
};

/** Refresh a moment before the server would reject the token, not after. */
const TOKEN_REFRESH_SKEW_SECONDS = 60;

/** A machine clock behind the server's must not turn every request into a refresh. */
const PROACTIVE_REFRESH_COOLDOWN_MS = 60_000;

/**
 * new-api reports a missing credential with HTTP 200 and a message such as
 * "无权进行此操作，未登录且未提供 access token", so the status code alone cannot
 * tell a dead session from an ordinary failure.
 */
const AUTH_FAILURE_PATTERN =
  /未登录|未提供\s*access\s*token|access\s*token\s*(?:无效|缺失|错误|过期)|invalid\s+access\s+token|access\s+token\s+(?:expired|invalid)|unauthorized|not\s+logged\s+in|login\s+(?:has\s+)?expired/i;

function isAuthFailure(response: RawResponse): boolean {
  if (response.status === 401) {
    return true;
  }
  if (response.data.success) {
    return false;
  }
  return AUTH_FAILURE_PATTERN.test(response.data.message ?? '');
}

/**
 * True when the access token is expired or about to be. Refreshing up front
 * avoids the burst of 401s a cold start otherwise produces, where a failed
 * refresh could race the in-flight requests and drop the session they rely on.
 */
export function accessTokenNeedsRefresh(session: StoredSession): boolean {
  const now = Math.floor(Date.now() / 1000);
  const declared = session.access_expires_at;
  if (!Number.isFinite(declared) || declared <= 0) {
    return false;
  }
  // Sites report the expiry in seconds; tolerate milliseconds just in case.
  const seconds = declared > 1e11 ? Math.floor(declared / 1000) : declared;
  return seconds - TOKEN_REFRESH_SKEW_SECONDS <= now;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function accountIdOf(session: StoredSession): string {
  return `${normalizeBaseUrl(session.baseUrl)}|${session.user?.username ?? ''}`;
}

/** Two sessions are the same login when the user id, or the site plus username, matches. */
function isSameAccount(a: StoredSession, b: StoredSession): boolean {
  if (a.user?.id && b.user?.id) {
    return a.user.id === b.user.id;
  }
  return (
    normalizeBaseUrl(a.baseUrl) === normalizeBaseUrl(b.baseUrl) &&
    (a.user?.username ?? '') === (b.user?.username ?? '')
  );
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
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

function emptyAccountStore(): AccountStore {
  return { version: 2, activeAccountId: null, accounts: {} };
}

async function readAccountStore(): Promise<AccountStore> {
  const raw = await AsyncStorage.getItem(ACCOUNTS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as AccountStore;
      if (parsed?.version === 2 && parsed.accounts && typeof parsed.accounts === 'object') {
        return parsed;
      }
    } catch {
      // 新格式损坏时回退到旧版会话迁移。
    }
  }
  const legacyRaw = await AsyncStorage.getItem(LEGACY_SESSION_KEY);
  if (legacyRaw) {
    try {
      const legacy = JSON.parse(legacyRaw) as StoredSession;
      if (legacy?.baseUrl && legacy.access_token) {
        const store = emptyAccountStore();
        const id = accountIdOf(legacy);
        store.accounts[id] = legacy;
        store.activeAccountId = id;
        await AsyncStorage.setItem(ACCOUNTS_KEY, JSON.stringify(store));
        await AsyncStorage.removeItem(LEGACY_SESSION_KEY);
        return store;
      }
    } catch {
      // 旧版数据无法解析时直接忽略。
    }
  }
  return emptyAccountStore();
}

async function writeAccountStore(store: AccountStore): Promise<void> {
  await AsyncStorage.setItem(ACCOUNTS_KEY, JSON.stringify(store));
}

export async function listAccounts(): Promise<StoredSession[]> {
  return Object.values((await readAccountStore()).accounts);
}

export async function loadSession(): Promise<StoredSession | null> {
  const store = await readAccountStore();
  return store.activeAccountId ? (store.accounts[store.activeAccountId] ?? null) : null;
}

export async function loadSessionById(accountId: string): Promise<StoredSession | null> {
  return (await readAccountStore()).accounts[accountId] ?? null;
}

/** 更新账号数据但不改变当前活跃账号（后台刷新时使用）。 */
export async function storeSession(session: StoredSession): Promise<void> {
  const store = await readAccountStore();
  const id = accountIdOf(session);
  store.accounts[id] = session;
  // 账号 id 里哈希了用户名，刷新可能把同一次登录写到新 key 上；跟着迁移，
  // 否则活跃账号一直指向旧条目，看板就再也取不到它的令牌。
  const activeId = store.activeAccountId;
  if (activeId && activeId !== id) {
    const active = store.accounts[activeId];
    if (active && isSameAccount(active, session)) {
      delete store.accounts[activeId];
      store.activeAccountId = id;
    }
  }
  await writeAccountStore(store);
}

export async function saveSession(session: StoredSession | null): Promise<void> {
  const store = await readAccountStore();
  if (session) {
    const id = accountIdOf(session);
    store.accounts[id] = session;
    store.activeAccountId = id;
  } else {
    if (store.activeAccountId) {
      delete store.accounts[store.activeAccountId];
    }
    const remaining = Object.keys(store.accounts);
    store.activeAccountId = remaining[0] ?? null;
  }
  await writeAccountStore(store);
}

export async function setActiveAccount(accountId: string): Promise<StoredSession | null> {
  const store = await readAccountStore();
  if (!store.accounts[accountId]) {
    return null;
  }
  store.activeAccountId = accountId;
  await writeAccountStore(store);
  return store.accounts[accountId];
}

export async function removeAccount(accountId: string): Promise<void> {
  const store = await readAccountStore();
  if (!store.accounts[accountId]) {
    return;
  }
  delete store.accounts[accountId];
  if (store.activeAccountId === accountId) {
    const remaining = Object.keys(store.accounts);
    store.activeAccountId = remaining[0] ?? null;
  }
  await writeAccountStore(store);
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
  private refreshInFlight: Promise<StoredSession | null> | null = null;

  /** When the token was last refreshed ahead of time, to keep a skewed clock in check. */
  private lastProactiveRefreshAt = 0;

  constructor(
    private readonly baseUrlInput: string,
    private readonly accountId?: string,
  ) {}

  private get baseUrl() {
    return normalizeBaseUrl(this.baseUrlInput);
  }

  private async scopedSession(): Promise<StoredSession | null> {
    if (!this.accountId) {
      return loadSession();
    }
    const direct = await loadSessionById(this.accountId);
    if (direct?.access_token) {
      return direct;
    }
    // 存储的 key 可能已经不再等于创建客户端时的 id（旧版本，或刷新重写过账号）；
    // 回退到同站点的活跃会话，而不是不带凭证发出去。
    const active = await loadSession();
    if (active?.access_token && normalizeBaseUrl(active.baseUrl) === this.baseUrl) {
      return active;
    }
    return direct;
  }

  /** 只清除失效会话所属的账号，不牵连其它账号。 */
  private async dropSession(session: StoredSession | null): Promise<void> {
    const accountId = session ? accountIdOf(session) : this.accountId;
    if (!accountId) {
      return;
    }
    await removeAccount(accountId);
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
    init: Parameters<NewApiClient['rawRequest']>[1] & { auth?: boolean } = {},
  ): Promise<T> {
    const sendInit = { method: init.method, headers: init.headers, body: init.body };
    const session = await this.scopedSession();
    if (init.auth !== false && !session?.access_token) {
      // 照样发出去只会换来 new-api 的“未登录且未提供 access token”，
      // 那句话会原样变成界面上刺眼的红色提示。
      throw new SessionExpiredError();
    }

    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    let current = session;
    if (
      current?.refresh_token &&
      Date.now() - this.lastProactiveRefreshAt > PROACTIVE_REFRESH_COOLDOWN_MS &&
      accessTokenNeedsRefresh(current)
    ) {
      const refreshed = await this.tryRefresh(current);
      if (refreshed) {
        this.lastProactiveRefreshAt = Date.now();
        current = refreshed;
      }
    }
    if (current?.access_token) {
      headers.Authorization = `Bearer ${current.access_token}`;
    }

    let response = await this.rawRequest(path, { ...sendInit, headers });
    if (isAuthFailure(response)) {
      const refreshed = current?.refresh_token ? await this.tryRefresh(current) : null;
      if (refreshed?.access_token) {
        // 用刷新刚拿到的令牌重试：重新读存储可能取不到，请求就光着出去了。
        current = refreshed;
        headers.Authorization = `Bearer ${refreshed.access_token}`;
        response = await this.rawRequest(path, { ...sendInit, headers });
      }
      if (!refreshed?.access_token || isAuthFailure(response)) {
        await this.dropSession(current ?? session);
        throw new SessionExpiredError();
      }
    }

    if (!response.data.success) {
      throw new Error(response.data.message || `请求失败 (${response.status})`);
    }
    return response.data.data as T;
  }

  private async tryRefresh(session: StoredSession): Promise<StoredSession | null> {
    // new-api rotates the refresh cookie on every use, so parallel 401s must
    // not each redeem the same token; the losers would look like a dead session.
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh(session)
        .catch(() => null)
        .finally(() => {
          this.refreshInFlight = null;
        });
    }
    return this.refreshInFlight;

  }

  getStatus(): Promise<NewApiStatus> {
    // 公共接口：登录页在任何会话存在之前就会调用它。
    return this.request<NewApiStatus>('/api/status', { auth: false });
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
      const twoFa = (data.methods ?? []).find(
        (method) => method.method === '2fa' && method.available,
      );
      if (!twoFa) {
        throw new Error(
          '该账号使用的登录验证方式暂不支持，请先在网页端完成验证流程',
        );
      }
      const challenge: LoginChallenge = {
        require_verification: true,
        flow_token: data.flow_token ?? '',
        expires_at: data.expires_at ?? 0,
        methods: data.methods ?? [],
      };
      throw new LoginVerificationRequiredError(
        '该账号开启了 2FA 验证，请输入动态验证码完成登录',
        challenge,
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

  /** 通过 new-api 新版登录验证流程提交 2FA 验证码。 */
  async verifyLogin(flowToken: string, code: string): Promise<LoginResult> {
    const response = await this.rawRequest('/api/user/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow_token: flowToken, code: code.trim() }),
    });
    if (!response.data.success) {
      throw new Error(response.data.message || '登录验证失败');
    }

    const data = response.data.data as LoginResult | undefined;
    if (!data?.access_token) {
      throw new Error('登录验证响应缺少访问令牌，请稍后重试');
    }
    const refreshToken = getRefreshCookie(response.headers);
    await saveSession({
      baseUrl: this.baseUrl,
      access_token: data.access_token,
      access_expires_at: data.access_expires_at,
      refresh_token: refreshToken,
      session_id: data.session?.sid,
      user: data.user,
    });
    return data;
  }

  /** 兑换刷新 Cookie，并返回它产生的新会话。 */
  async refresh(session: StoredSession): Promise<StoredSession> {
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
    const next: StoredSession = {
      ...session,
      access_token: data.access_token,
      access_expires_at: data.access_expires_at,
      refresh_token: nextRefreshToken,
      session_id: data.session?.sid ?? session.session_id,
      user: data.user ?? session.user,
    };
    await storeSession(next);
    return next;
  }

  /** 先通知服务端吊销会话，再清除本地会话。 */
  async logout(): Promise<void> {
    const session = await this.scopedSession();
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
    if (this.accountId) {
      await removeAccount(this.accountId);
    } else {
      await saveSession(null);
    }
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
