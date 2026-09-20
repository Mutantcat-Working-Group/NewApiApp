import AsyncStorage from '@react-native-async-storage/async-storage';
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

  private async request<T>(path: string, init: Parameters<NewApiClient['rawRequest']>[1] = {}): Promise<T> {
    const session = await loadSession();
    const headers: Record<string, string> = {
      ...(init.headers ?? {}),
    };
    if (session?.access_token) {
      headers.Authorization = `Bearer ${session.access_token}`;
    }
    let response = await this.rawRequest(path, { ...init, headers });
    if (response.status === 401 && session?.refresh_token) {
      await this.refresh();
      const newSession = await loadSession();
      if (newSession?.access_token) {
        headers.Authorization = `Bearer ${newSession.access_token}`;
      }
      response = await this.rawRequest(path, { ...init, headers });
    }
    if (!response.data.success) {
      throw new Error(response.data.message || `请求失败 (${response.status})`);
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
      throw new Error(login.data.message || '登录失败');
    }
    const data = login.data.data as LoginResult;
    const refreshToken = getRefreshCookie(login.headers);
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

  async refresh(): Promise<void> {
    const session = await loadSession();
    if (!session?.refresh_token) {
      throw new Error('缺少刷新令牌，请重新登录');
    }
    const refresh = await this.rawRequest('/api/user/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `new_api_refresh=${encodeURIComponent(session.refresh_token)}`,
        'X-Auth-Session': session.session_id ?? '',
      },
      body: '{}',
    });
    if (!refresh.data.success) {
      throw new Error(refresh.data.message || '刷新会话失败');
    }
    const data = refresh.data.data as LoginResult;
    const nextRefreshToken = getRefreshCookie(refresh.headers) ?? session.refresh_token;
    await saveSession({
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
}
