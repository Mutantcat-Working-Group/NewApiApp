export type NewApiStatus = {
  version: string;
  system_name: string;
  logo: string;
  quota_per_unit: number;
  display_in_currency: boolean;
  quota_display_type: string;
  custom_currency_symbol: string;
  custom_currency_exchange_rate: number;
  usd_exchange_rate: number;
  password_login_enabled: boolean;
  password_login_encryption_enabled: boolean;
  register_enabled: boolean;
};

export type SelfUser = {
  id: number;
  username: string;
  display_name: string;
  role: number;
  status: number;
  email: string;
  group: string;
  quota: number;
  used_quota: number;
  request_count: number;
  aff_code?: string;
  aff_count?: number;
  aff_quota?: number;
};

export type LoginSession = {
  sid: string;
  current: boolean;
  login_method: string;
  ip: string;
  user_agent: string;
  created_at: number;
  last_active_at: number;
  expires_at: number;
};

export type LoginResult = {
  access_token: string;
  token_type: string;
  access_expires_at: number;
  user: SelfUser;
  session: LoginSession;
};

export type TokenItem = {
  id: number;
  name: string;
  key: string;
  status: number;
  created_time: number;
  accessed_time: number;
  expired_time: number;
  remain_quota: number;
  used_quota?: number;
  unlimited_quota: boolean;
  model_limits_enabled: boolean;
};

export type LogStat = {
  quota: number;
  rpm: number;
  tpm: number;
};

export type ApiEnvelope<T> = {
  success: boolean;
  message?: string;
  code?: string;
  data?: T;
};

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  page_size: number;
};
