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
  turnstile_check: boolean;
};

export type VerificationMethod = {
  method: string;
  available: boolean;
  reason?: string;
};

/** Challenge returned by /api/user/login when the account requires verification (2FA / passkey). */
export type LoginChallenge = {
  require_verification: boolean;
  flow_token: string;
  expires_at: number;
  methods: VerificationMethod[];
};

export type EncryptionKeyInfo = {
  enabled: boolean;
  kid?: string;
  public_key?: string;
};

export type LogoutResult = {
  revoked_sid: string;
  cookie_cleared: boolean;
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

export type TokenPayload = {
  id?: number;
  name: string;
  expired_time: number;
  remain_quota: number;
  unlimited_quota: boolean;
  model_limits_enabled: boolean;
  model_limits?: string;
  allow_ips?: string;
  group: string;
  cross_group_retry: boolean;
  status?: number;
};

export type LogItem = {
  id: number;
  user_id: number;
  created_at: number;
  type: number;
  content?: string;
  username?: string;
  token_name: string;
  model_name: string;
  quota: number;
  prompt_tokens: number;
  completion_tokens: number;
  use_time: number;
  is_stream?: boolean;
  group?: string;
  ip?: string;
  request_id?: string;
  channel_name?: string;
};

export type QuotaDateItem = {
  id: number;
  user_id: number;
  model_name: string;
  created_at: number;
  use_group: string;
  token_id: number;
  channel_id: number;
  node_name: string;
  token_used: number;
  count: number;
  quota: number;
};

export type TopUpItem = {
  id: number;
  user_id: number;
  amount: number;
  money: number;
  trade_no: string;
  payment_method: string;
  payment_provider: string;
  create_time: number;
  complete_time: number;
  status: string;
};

export type TopUpInfo = {
  enable_online_topup?: boolean;
  enable_redemption?: boolean;
  payment_compliance_confirmed?: boolean;
  topup_link?: string;
  amount_options?: number[];
  min_topup?: number;
  pay_methods?: Array<{ name: string; type: string; color?: string; min_topup?: string }>;
};

export type CheckinStatus = {
  enabled: boolean;
  min_quota: number;
  max_quota: number;
  stats?: {
    total_quota: number;
    total_checkins: number;
    checkin_count: number;
    checked_in_today: boolean;
    records: Array<{ checkin_date: string; quota_awarded: number }>;
  };
};

export type CheckinResult = {
  quota_awarded: number;
  checkin_date: string;
};

export type SubscriptionPlan = {
  plan: {
    id: number;
    title: string;
    subtitle?: string;
    price_amount: number;
    currency: string;
    duration_unit: string;
    duration_value: number;
    total_amount: number;
    quota_reset_period?: string;
    allow_balance_pay?: boolean | null;
    allow_wallet_overflow?: boolean | null;
    upgrade_group?: string;
  };
};

export type UserSubscription = {
  id: number;
  plan_id: number;
  amount_total: number;
  amount_used: number;
  start_time: number;
  end_time: number;
  status: string;
  source?: string;
  upgrade_group?: string;
};

export type SubscriptionSelf = {
  billing_preference?: string;
  subscriptions?: UserSubscription[];
  all_subscriptions?: UserSubscription[];
};

export type GroupInfo = {
  ratio: string;
  desc: string;
};
