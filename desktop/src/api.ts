import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type {
  ApiEnvelope,
  LogStat,
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

type RawResponse = {
  ok: boolean;
  status: number;
  data: ApiEnvelope<unknown>;
  headers: Record<string, string>;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[String(key).toLowerCase()] = String(value);
  });
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
      ...(init.headers ?? {}),
    };
    const response = await tauriFetch(this.endpoint(path), {
      method: init.method ?? 'GET',
      headers,
      body: init.body,
    });
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
      headers: collectHeaders(response.headers),
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
      await this.refresh();
      const nextSession = loadSession();
      if (nextSession?.access_token) {
        headers.Authorization = `Bearer ${nextSession.access_token}`;
      }
      response = await this.rawRequest(path, { ...init, headers });
    }

    if (!response.data.success) {
      throw new Error(response.data.message || `Request failed (${response.status})`);
    }
    return response.data.data as T;
  }

  getStatus(): Promise<NewApiStatus> {
    return this.request<NewApiStatus>('/api/status');
  }

  async passwordLogin(username: string, password: string): Promise<LoginResult> {
    const login = await this.rawRequest('/api/user/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!login.data.success) {
      throw new Error(login.data.message || 'Login failed');
    }

    const data = login.data.data as LoginResult;
    const refreshToken = getRefreshCookie(login.headers);
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

  async refresh(): Promise<void> {
    const session = loadSession();
    if (!session?.refresh_token) {
      throw new Error('Missing refresh token, please sign in again');
    }
    const response = await this.rawRequest('/api/user/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `new_api_refresh=${encodeURIComponent(session.refresh_token)}`,
        'X-Auth-Session': session.session_id ?? '',
      },
      body: '{}',
    });
    if (!response.data.success) {
      throw new Error(response.data.message || 'Refresh failed');
    }

    const data = response.data.data as LoginResult;
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

  getSelf(): Promise<SelfUser> {
    return this.request<SelfUser>('/api/user/self');
  }

  async getTokens(): Promise<TokenItem[]> {
    const page = await this.request<PageResult<TokenItem>>('/api/token/?page=1&size=100');
    return page.items ?? [];
  }

  getSelfLogStat(): Promise<LogStat> {
    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 24 * 60 * 60;
    return this.request<LogStat>(
      `/api/log/self/stat?start_timestamp=${dayAgo}&end_timestamp=${now}`,
    );
  }

  logout(): void {
    saveSession(null);
  }
}
