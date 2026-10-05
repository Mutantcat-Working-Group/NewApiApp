import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { emit } from '@tauri-apps/api/event';
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

/** new-api rate-limits bursts, so the dashboard's parallel fan-out stays polite. */
const MAX_INBOUND_CONCURRENCY = 3;
const REQUEST_MIN_GAP_MS = 90;
const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 800;
const RATE_LIMIT_WAIT_CAP_MS = 10_000;

/** Thrown when the refresh token is no longer accepted; the UI returns to the login screen. */
export class SessionExpiredError extends Error {
  constructor(message = 'Session expired, please sign in again') {
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

/** Thrown when the site keeps answering 429 after the client retried with backoff. */
export class RateLimitError extends Error {
  readonly retryAfterMs: number | null;

  constructor(
    message = '站点接口限流（429），请求过于频繁，请稍后重试',
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
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
  return match ? decodeURIComponent(match[1]) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** How long to wait before resending after a 429, honouring Retry-After when present. */
function retryAfterDelayMs(headers: Record<string, string>, attempt: number): number {
  const raw = (headers['retry-after'] ?? '').trim();
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.max(seconds * 1000, 250), RATE_LIMIT_WAIT_CAP_MS);
    }
    const at = Date.parse(raw);
    if (Number.isFinite(at)) {
      return Math.min(Math.max(at - Date.now(), 250), RATE_LIMIT_WAIT_CAP_MS);
    }
  }
  return Math.min(RATE_LIMIT_BACKOFF_MS * 2 ** attempt, RATE_LIMIT_WAIT_CAP_MS);
}

type RequestGate = {
  active: number;
  nextStartAt: number;
  waiters: Array<() => void>;
  timer: number | null;
};

const requestGate: RequestGate = { active: 0, nextStartAt: 0, waiters: [], timer: null };

function pumpRequestGate(): void {
  if (requestGate.timer !== null) {
    window.clearTimeout(requestGate.timer);
    requestGate.timer = null;
  }
  while (
    requestGate.active < MAX_INBOUND_CONCURRENCY &&
    requestGate.waiters.length > 0 &&
    Date.now() >= requestGate.nextStartAt
  ) {
    const wake = requestGate.waiters.shift();
    requestGate.nextStartAt = Date.now() + REQUEST_MIN_GAP_MS;
    requestGate.active += 1;
    wake?.();
  }
  if (requestGate.active < MAX_INBOUND_CONCURRENCY && requestGate.waiters.length > 0) {
    const delay = Math.max(20, requestGate.nextStartAt - Date.now());
    requestGate.timer = window.setTimeout(() => {
      requestGate.timer = null;
      pumpRequestGate();
    }, delay);
  }
}

function acquireRequestSlot(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestGate.waiters.push(resolve);
    pumpRequestGate();
  });
}

function releaseRequestSlot(): void {
  requestGate.active = Math.max(0, requestGate.active - 1);
  pumpRequestGate();
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
  store.accounts[accountIdOf(session)] = session;
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
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(
    private readonly baseUrlInput: string,
    private readonly accountId?: string,
  ) {}

  private get baseUrl() {
    return normalizeBaseUrl(this.baseUrlInput);
  }

  private scopedSession(): StoredSession | null {
    return this.accountId ? loadSessionById(this.accountId) : loadSession();
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
    await acquireRequestSlot();
    try {
      return await this.sendRequest(path, init);
    } finally {
      releaseRequestSlot();
    }
  }

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

  /** Sends a request through the gate, retrying 429s with backoff. */
  private async fetchThrough(
    path: string,
    init: Parameters<NewApiClient['sendRequest']>[1],
  ): Promise<RawResponse> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.rawRequest(path, init);
      if (response.status !== 429) {
        return response;
      }
      if (attempt >= RATE_LIMIT_MAX_RETRIES) {
        throw new RateLimitError();
      }
      await sleep(retryAfterDelayMs(response.headers, attempt));
    }
  }

  private async request<T>(
    path: string,
    init: Parameters<NewApiClient['rawRequest']>[1] = {},
  ): Promise<T> {
    const session = this.scopedSession();
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (session?.access_token) {
      headers.Authorization = `Bearer ${session.access_token}`;
    }

    let response = await this.fetchThrough(path, { ...init, headers });
    if (response.status === 401 && session?.refresh_token) {
      const refreshed = await this.tryRefresh(session);
      if (refreshed) {
        const nextSession = this.scopedSession();
        if (nextSession?.access_token) {
          headers.Authorization = `Bearer ${nextSession.access_token}`;
        }
        response = await this.fetchThrough(path, { ...init, headers });
      }
      if (!refreshed || response.status === 401) {
        if (this.accountId) {
          removeAccount(this.accountId);
        } else {
          saveSession(null);
        }
        throw new SessionExpiredError();
      }
    }

    if (!response.data.success) {
      throw new Error(response.data.message || `Request failed (${response.status})`);
    }
    return response.data.data as T;
  }

  private async tryRefresh(session: StoredSession): Promise<boolean> {
    // new-api rotates the refresh cookie on every use, so parallel 401s must
    // not each redeem the same token; the losers would look like a dead session.
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh(session)
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
      body: JSON.stringify({ flow_token: flowToken, code: code.trim() }),
    });
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

  async refresh(session: StoredSession): Promise<void> {
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
    storeSession({
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
