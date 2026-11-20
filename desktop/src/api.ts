import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { emit } from '@tauri-apps/api/event';
import { encryptLoginPassword } from './crypto/login-crypto';
import {
  acquireSlot,
  noteLimited,
  noteServed,
  releaseSlot,
  type RateLimitClass,
} from './rate-limit';
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

type AccountStore = {
  version: 2;
  activeAccountId: string | null;
  accounts: Record<string, StoredSession>;
};

const LEGACY_SESSION_KEY = 'newapi.session.v1';
const ACCOUNTS_KEY = 'newapi.accounts.v2';
const PAGE_SIZE = 100;
const MAX_TOKEN_PAGES = 20;
const REQUEST_TIMEOUT_MS = 20_000;

/** Shown in place of new-api's raw "无权进行此操作，未登录且未提供 access token" reply. */
const SESSION_EXPIRED_MESSAGE = '登录状态已失效，请重新登录';

/** Thrown when the refresh token is no longer accepted; the UI returns to the login screen. */
export class SessionExpiredError extends Error {
  constructor(message = SESSION_EXPIRED_MESSAGE) {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/** Thrown when the site asks for a 2FA code after the password step. */
export class LoginVerificationRequiredError extends Error {
  readonly challenge: LoginChallenge;

  constructor(message: string, challenge: LoginChallenge) {
    super(message);
    this.name = 'LoginVerificationRequiredError';
    this.challenge = challenge;
  }
}

/**
 * Thrown when new-api answers 429 and the client's own budget has nothing left
 * to spend. Callers keep the last cached data on screen and retry later.
 */
export class RateLimitError extends Error {
  readonly retryAfterMs: number | null;
  readonly limited: boolean;

  constructor(retryAfterMs: number | null = null) {
    super('站点接口限流（429），已保留上一次数据，稍后自动重试');
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
    this.limited = true;
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

export function accountIdOf(session: StoredSession): string {
  return `${normalizeBaseUrl(session.baseUrl)}|${session.user?.username ?? ''}`;
}

/** Two sessions are the same login when the user id, or the site plus username, matches. */
export function isSameAccount(a: StoredSession, b: StoredSession): boolean {
  if (a.user?.id && b.user?.id) {
    return a.user.id === b.user.id;
  }
  return (
    normalizeBaseUrl(a.baseUrl) === normalizeBaseUrl(b.baseUrl) &&
    (a.user?.username ?? '') === (b.user?.username ?? '')
  );
}

/**
 * Field-level comparison. The main window treats a stored session as "the
 * same account" and skips its reload, so writes that change nothing must
 * not broadcast accounts-changed either.
 */
export function sessionsEqual(a: StoredSession, b: StoredSession): boolean {
  if (a === b) {
    return true;
  }
  if (
    normalizeBaseUrl(a.baseUrl) !== normalizeBaseUrl(b.baseUrl) ||
    a.access_token !== b.access_token ||
    (a.refresh_token ?? '') !== (b.refresh_token ?? '') ||
    (a.session_id ?? '') !== (b.session_id ?? '') ||
    a.access_expires_at !== b.access_expires_at
  ) {
    return false;
  }
  return JSON.stringify(a.user ?? null) === JSON.stringify(b.user ?? null);
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
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
  if (!match) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // A stray percent sign must not take the whole login down with it.
    return match[1];
  }
}

/** new-api sends Retry-After as whole seconds on its fixed-window limiter. */
export function retryAfterMsOf(headers: Record<string, string>): number | null {
  const raw = (headers['retry-after'] ?? '').trim();
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const at = Date.parse(raw);
    if (Number.isFinite(at)) {
      return at - Date.now();
    }
  }
  return null;
}

/** Refresh a moment before the server would reject the token, not after. */
const TOKEN_REFRESH_SKEW_SECONDS = 60;

/** A machine clock behind the server's must not turn every request into a refresh. */
const PROACTIVE_REFRESH_COOLDOWN_MS = 60_000;

/** new-api signs access tokens as JWTs, so the expiry is readable locally. */
function jwtExpirySeconds(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: number;
    };
    return typeof payload.exp === 'number' && payload.exp > 0 ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * True when the access token is expired or about to be. Refreshing up front
 * avoids the burst of 401s a cold start otherwise produces, where a failed
 * refresh could race the in-flight requests and drop the session they rely on.
 */
function accessTokenNeedsRefresh(session: StoredSession): boolean {
  const now = Math.floor(Date.now() / 1000);
  const fromJwt = jwtExpirySeconds(session.access_token);
  if (fromJwt !== null) {
    return fromJwt - TOKEN_REFRESH_SKEW_SECONDS <= now;
  }
  const declared = session.access_expires_at;
  if (!Number.isFinite(declared) || declared <= 0) {
    return false;
  }
  // Sites report the expiry in seconds; tolerate milliseconds just in case.
  const seconds = declared > 1e11 ? Math.floor(declared / 1000) : declared;
  return seconds - TOKEN_REFRESH_SKEW_SECONDS <= now;
}

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
 * 关键路由：new-api 在这几条上挂着 20 次 / 20 分钟的独立预算，
 * 一旦被拒，令牌刷新与登出会一起停摆，所以它们单独计数、单独退避。
 */
const CRITICAL_ROUTE_PATTERN =
  /^\/api\/user\/(auth\/|login)|^\/api\/token\/(?:\d+\/key|batch\/keys)/;

function rateLimitClassOf(path: string): RateLimitClass {
  return CRITICAL_ROUTE_PATTERN.test(path) ? 'critical' : 'global';
}

function notifyAccountsChanged(): void {
  try {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      void emit('accounts-changed', null);
    }
  } catch {
    // Non-Tauri contexts have no other windows to notify.
  }
}

function emptyAccountStore(): AccountStore {
  return { version: 2, activeAccountId: null, accounts: {} };
}

function readAccountStore(): AccountStore {
  const raw = localStorage.getItem(ACCOUNTS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as AccountStore;
      if (parsed?.version === 2 && parsed.accounts && typeof parsed.accounts === 'object') {
        return parsed;
      }
    } catch {
      // Fall through to the legacy session below.
    }
  }
  const legacyRaw = localStorage.getItem(LEGACY_SESSION_KEY);
  if (legacyRaw) {
    try {
      const legacy = JSON.parse(legacyRaw) as StoredSession;
      if (legacy?.baseUrl && legacy.access_token) {
        const store = emptyAccountStore();
        const id = accountIdOf(legacy);
        store.accounts[id] = legacy;
        store.activeAccountId = id;
        localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(store));
        localStorage.removeItem(LEGACY_SESSION_KEY);
        return store;
      }
    } catch {
      // Ignore malformed legacy data.
    }
  }
  return emptyAccountStore();
}

function writeAccountStore(store: AccountStore): void {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(store));
  notifyAccountsChanged();
}

export function listAccounts(): StoredSession[] {
  return Object.values(readAccountStore().accounts);
}

export function loadSession(): StoredSession | null {
  const store = readAccountStore();
  return store.activeAccountId ? (store.accounts[store.activeAccountId] ?? null) : null;
}

export function loadSessionById(accountId: string): StoredSession | null {
  return readAccountStore().accounts[accountId] ?? null;
}

/** Upserts a session without changing which account is active (background refresh). */
export function storeSession(session: StoredSession): void {
  const store = readAccountStore();
  const id = accountIdOf(session);
  const existing = store.accounts[id];
  // The account id hashes the username, so a refresh can land the same login
  // under a different key. Follow it, otherwise the active account keeps
  // pointing at the stale entry and the dashboard stops finding its token.
  const activeEntry = store.activeAccountId ? store.accounts[store.activeAccountId] : null;
  const needsMigration = Boolean(
    activeEntry && store.activeAccountId !== id && isSameAccount(activeEntry, session),
  );
  // The dashboard's own success path writes the fresh user back. Broadcasting
  // that write makes the window reload the very request that produced it,
  // forever, and the site answers the loop with 429s. Nothing changed here,
  // so skip the store, the event, and the reload it causes.
  if (existing && sessionsEqual(existing, session) && !needsMigration) {
    return;
  }
  store.accounts[id] = session;
  const activeId = store.activeAccountId;
  if (activeId && activeId !== id) {
    const active = store.accounts[activeId];
    if (active && isSameAccount(active, session)) {
      delete store.accounts[activeId];
      store.activeAccountId = id;
    }
  }
  writeAccountStore(store);
}

export function saveSession(session: StoredSession | null): void {
  const store = readAccountStore();
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
  writeAccountStore(store);
}

export function setActiveAccount(accountId: string): StoredSession | null {
  const store = readAccountStore();
  if (!store.accounts[accountId]) {
    return null;
  }
  store.activeAccountId = accountId;
  writeAccountStore(store);
  return store.accounts[accountId];
}

export function removeAccount(accountId: string): void {
  const store = readAccountStore();
  if (!store.accounts[accountId]) {
    return;
  }
  delete store.accounts[accountId];
  if (store.activeAccountId === accountId) {
    const remaining = Object.keys(store.accounts);
    store.activeAccountId = remaining[0] ?? null;
  }
  writeAccountStore(store);
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

  private scopedSession(): StoredSession | null {
    if (!this.accountId) {
      return loadSession();
    }
    const direct = loadSessionById(this.accountId);
    if (direct?.access_token) {
      return direct;
    }
    // The stored key may no longer hash to the id this client was built with
    // (an older build, or a refresh that rewrote the account). Fall back to the
    // active session for the same site instead of sending no credentials.
    const active = loadSession();
    if (active?.access_token && normalizeBaseUrl(active.baseUrl) === this.baseUrl) {
      return active;
    }
    return direct;
  }

  /** Forgets the account a dead session belonged to, never an unrelated one. */
  private dropSession(session: StoredSession | null): void {
    const accountId = session ? accountIdOf(session) : this.accountId;
    if (!accountId) {
      return;
    }
    removeAccount(accountId);
  }

  private endpoint(path: string) {
    return `${this.baseUrl}${path}`;
  }

  /**
   * 走客户端的请求预算（见 rate-limit.ts）发一个请求：预算不足时排队等待，
   * 而不是让服务端回 429。返回 429 时不在这里重试——服务端给出的等待时间
   * 会作为退避写进预算，由调用方决定是否还要再发一次。
   */
  private async rawRequest(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<RawResponse> {
    const cls = rateLimitClassOf(path);
    await acquireSlot(cls === 'critical');
    try {
      const response = await this.sendRequest(path, init);
      if (response.status === 429) {
        noteLimited(cls, retryAfterMsOf(response.headers));
      } else {
        noteServed();
      }
      return response;
    } finally {
      releaseSlot();
    }
  }

  /** Sends a request once the budget grants a slot. */
  private async sendRequest(
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
    // A request sent right before the host slept can come back after wake in
    // a half-open state; abort it so the watchdog can refresh instead of
    // waiting forever on a stale promise.
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await tauriFetch(this.endpoint(path), {
          method: init.method ?? 'GET',
          headers,
          body: init.body,
          signal: controller.signal,
        });
      } catch (fetchError) {
        if (controller.signal.aborted) {
          throw new Error('请求超时，请检查网络');
        }
        throw fetchError;
      }

      const responseHeaders = collectHeaders(response.headers);
      let data: ApiEnvelope<unknown> = { success: response.ok };
      try {
        data = (await response.json()) as ApiEnvelope<unknown>;
      } catch {
        if (controller.signal.aborted) {
          throw new Error('请求超时，请检查网络');
        }
        data = { success: response.ok };
      }
      return {
        ok: response.ok,
        status: response.status,
        data,
        headers: responseHeaders,
      };
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  /**
   * 发送一个请求。429 由调用方决定是否重发：预刷新与 401 重试必须再发一次，
   * 看板的常规读请求则直接把限流状态抛出去，让上层用缓存数据兜底。
   */
  private async fetchThrough(
    path: string,
    init: Parameters<NewApiClient['sendRequest']>[1],
  ): Promise<RawResponse> {
    return this.rawRequest(path, init);
  }

  private async request<T>(
    path: string,
    init: Parameters<NewApiClient['rawRequest']>[1] & { auth?: boolean } = {},
  ): Promise<T> {
    const sendInit = { method: init.method, headers: init.headers, body: init.body };
    const session = this.scopedSession();
    if (init.auth !== false && !session?.access_token) {
      // Sending it anyway would only earn new-api's "未登录且未提供 access token"
      // reply, which used to surface as a raw red banner on the dashboard.
      throw new SessionExpiredError();
    }

    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    let current = session;
    if (
      current?.refresh_token &&
      Date.now() - this.lastProactiveRefreshAt > PROACTIVE_REFRESH_COOLDOWN_MS &&
      accessTokenNeedsRefresh(current)
    ) {
      try {
        const refreshed = await this.tryRefresh(current);
        if (refreshed) {
          this.lastProactiveRefreshAt = Date.now();
          current = refreshed;
        }
      } catch (refreshError) {
        // The critical budget is spent: surface the limit instead of sending
        // the request with a token the server is about to reject anyway.
        if (refreshError instanceof RateLimitError) {
          throw refreshError;
        }
      }
    }
    if (current?.access_token) {
      headers.Authorization = `Bearer ${current.access_token}`;
    }

    let response = await this.fetchThrough(path, { ...sendInit, headers });
    if (response.status === 429) {
      throw new RateLimitError(retryAfterMsOf(response.headers));
    }
    if (isAuthFailure(response)) {
      let refreshed: StoredSession | null = null;
      try {
        refreshed = current?.refresh_token ? await this.tryRefresh(current) : null;
      } catch (refreshError) {
        // Rate-limited refresh: the session is still alive, just throttled.
        if (refreshError instanceof RateLimitError) {
          throw refreshError;
        }
      }
      if (refreshed?.access_token) {
        // Retry with the token the refresh just produced: re-reading the store
        // could miss it and send the request unauthenticated.
        current = refreshed;
        headers.Authorization = `Bearer ${refreshed.access_token}`;
        response = await this.fetchThrough(path, { ...sendInit, headers });
        if (response.status === 429) {
          throw new RateLimitError(retryAfterMsOf(response.headers));
        }
      }
      if (!refreshed?.access_token || isAuthFailure(response)) {
        this.dropSession(current ?? session);
        throw new SessionExpiredError();
      }
    }

    if (!response.data.success) {
      throw new Error(response.data.message || `Request failed (${response.status})`);
    }
    return response.data.data as T;
  }

  private async tryRefresh(session: StoredSession): Promise<StoredSession | null> {
    // new-api rotates the refresh cookie on every use, so parallel 401s must
    // not each redeem the same token; the losers would look like a dead session.
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh(session)
        .catch((error: unknown) => {
          // A rate limit is not a dead session. Swallowing it here would make
          // the caller drop the account, so let it propagate instead.
          if (error instanceof RateLimitError) {
            throw error;
          }
          return null;
        })
        .finally(() => {
          this.refreshInFlight = null;
        });
    }
    return this.refreshInFlight;
  }

  getStatus(): Promise<NewApiStatus> {
    // Public endpoint: the login screen uses it before any session exists.
    return this.request<NewApiStatus>('/api/status', { auth: false });
  }

  /** GET /api/user/login/encryption-key; enabled is false when the site does not encrypt passwords. */
  async getEncryptionKey(): Promise<EncryptionKeyInfo> {
    const response = await this.rawRequest('/api/user/login/encryption-key');
    if (response.status === 429) {
      throw new RateLimitError(retryAfterMsOf(response.headers));
    }
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
    if (login.status === 429) {
      throw new RateLimitError(retryAfterMsOf(login.headers));
    }
    if (!login.data.success) {
      throw new Error(login.data.message || 'Login failed');
    }

    const data = login.data.data as (LoginResult & Partial<LoginChallenge>) | undefined;
    if (!data || typeof data !== 'object') {
      throw new Error('Unexpected login response, please try again later');
    }
    if (data.require_verification) {
      const twoFa = (data.methods ?? []).find(
        (method) => method.method === '2fa' && method.available,
      );
      if (!twoFa) {
        throw new Error(
          'This account uses a login verification method the app does not support yet; ' +
            'complete it on the website first',
        );
      }
      const challenge: LoginChallenge = {
        require_verification: true,
        flow_token: data.flow_token ?? '',
        expires_at: data.expires_at ?? 0,
        methods: data.methods ?? [],
      };
      throw new LoginVerificationRequiredError(
        'This account has 2FA enabled; enter the verification code to continue',
        challenge,
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

  /** Completes the new-api login verification flow with a 2FA code. */
  async verifyLogin(flowToken: string, code: string): Promise<LoginResult> {
    const response = await this.rawRequest('/api/user/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // new-api reads `method` from the body and falls back to 2FA; say it outright.
      body: JSON.stringify({ flow_token: flowToken, code: code.trim(), method: '2fa' }),
    });
    if (response.status === 429) {
      throw new RateLimitError(retryAfterMsOf(response.headers));
    }
    if (!response.data.success) {
      throw new Error(response.data.message || 'Login verification failed');
    }

    const data = response.data.data as LoginResult | undefined;
    if (!data?.access_token) {
      throw new Error('Login verification response is missing an access token, please try again later');
    }
    const refreshToken = getRefreshCookie(response.headers);
    saveSession({
      baseUrl: this.baseUrl,
      access_token: data.access_token,
      access_expires_at: data.access_expires_at,
      refresh_token: refreshToken,
      session_id: data.session?.sid,
      user: data.user,
    });
    return data;
  }

  /** Redeems the refresh cookie and returns the session it produced. */
  async refresh(session: StoredSession): Promise<StoredSession> {
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
    if (response.status === 429) {
      // The session is fine; the client just hit the critical-route budget.
      throw new RateLimitError(retryAfterMsOf(response.headers));
    }
    if (!response.data.success) {
      throw new SessionExpiredError(response.data.message || 'Refresh failed');
    }

    const data = response.data.data as LoginResult | undefined;
    if (!data?.access_token) {
      throw new SessionExpiredError('Refresh response is missing an access token');
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
    storeSession(next);
    return next;
  }

  /** Tells the server to revoke the session, then clears the local one. */
  async logout(): Promise<void> {
    const session = this.scopedSession();
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
    if (this.accountId) {
      removeAccount(this.accountId);
    } else {
      saveSession(null);
    }
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
