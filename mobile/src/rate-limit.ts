/**
 * 客户端请求预算，用来对齐 new-api 内置的请求频率限制。
 *
 * new-api 按客户端 IP 统计，且默认开启（common/init.go）：
 *   - GlobalApiRateLimit：360 次 / 180 秒，覆盖整个 /api 分组
 *   - CriticalRateLimit： 20 次 / 1200 秒，覆盖登录、刷新、登出与令牌密钥读取
 * 两者都是固定窗口，窗口边界最多可放入配置值的两倍。私有部署通常只有一个客户端，
 * 于是这个预算基本被本应用独占：贴着上限跑会把每一次看板刷新都变成 429，关键路由
 * 甚至可能让账号在几分钟内无法刷新令牌。
 *
 * 治理器只花掉预算的一部分，放不下的请求进队列等待，而不是被服务端拒绝。服务端
 * 仍然返回 429 时，noteLimited 会清空令牌桶并让后续请求等到服务端重新接受的时刻。
 */

export type RateLimitClass = 'global' | 'critical';

/** new-api 的默认值；部署方只能调大，客户端按最保守的情况适配。 */
const GLOBAL_LIMIT = 360;
const GLOBAL_WINDOW_MS = 180_000;
const CRITICAL_LIMIT = 20;
const CRITICAL_WINDOW_MS = 1_200_000;

/** 本客户端花掉的预算比例，余量留给同 NAT 后的其它客户端和网页端。 */
const BUDGET_SHARE = 0.75;

/** 同时发出的请求数，避免把私有部署的单线程 gin 打满。 */
const MAX_CONCURRENCY = 3;

const GLOBAL_CAPACITY = 15;
const CRITICAL_CAPACITY = 3;

/** 服务端拒答后最长按住多久；按住太久界面会像卡死。 */
const BLOCKED_CEILING_MS: Record<RateLimitClass, number> = {
  global: 30_000,
  critical: 300_000,
};

/** 服务端没给 Retry-After 时的默认按住时间。 */
const BLOCKED_FALLBACK_MS: Record<RateLimitClass, number> = {
  global: 10_000,
  critical: 120_000,
};

type Bucket = {
  tokens: number;
  capacity: number;
  refillPerMs: number;
  refilledAt: number;
  blockedUntil: number;
};

type TimerHandle = ReturnType<typeof setTimeout>;

function createBucket(capacity: number, limit: number, windowMs: number): Bucket {
  return {
    tokens: capacity,
    capacity,
    refillPerMs: (limit * BUDGET_SHARE) / windowMs,
    refilledAt: Date.now(),
    blockedUntil: 0,
  };
}

const buckets: Record<RateLimitClass, Bucket> = {
  global: createBucket(GLOBAL_CAPACITY, GLOBAL_LIMIT, GLOBAL_WINDOW_MS),
  critical: createBucket(CRITICAL_CAPACITY, CRITICAL_LIMIT, CRITICAL_WINDOW_MS),
};

function refill(bucket: Bucket, now: number): void {
  if (now <= bucket.refilledAt) {
    return;
  }
  bucket.tokens = Math.min(
    bucket.capacity,
    bucket.tokens + (now - bucket.refilledAt) * bucket.refillPerMs,
  );
  bucket.refilledAt = now;
}

/** 还要多久这个桶才允许再发一个请求。 */
function waitFor(bucket: Bucket, now: number): number {
  refill(bucket, now);
  if (bucket.tokens >= 1) {
    return Math.max(0, bucket.blockedUntil - now);
  }
  const untilRefill = Math.ceil((1 - bucket.tokens) / bucket.refillPerMs);
  return Math.max(untilRefill, bucket.blockedUntil - now, 0);
}

function spend(bucket: Bucket): void {
  refill(bucket, Date.now());
  bucket.tokens = Math.max(0, bucket.tokens - 1);
}

type Waiter = { critical: boolean; resolve: () => void };

const waiters: Waiter[] = [];
let inFlight = 0;
let pumpTimer: TimerHandle | null = null;
let ticker: TimerHandle | null = null;

export type RateLimitStatus = {
  /** 服务端拒答过，或正在按住请求。 */
  limited: boolean;
  /** 请求因客户端预算不足在排队。 */
  waiting: boolean;
  /** 距离解除按住还剩多久，未按住时为 null。 */
  retryInMs: number | null;
  /** 最后一次触发的是哪一档，便于说明原因。 */
  cls: RateLimitClass | null;
};

let status: RateLimitStatus = {
  limited: false,
  waiting: false,
  retryInMs: null,
  cls: null,
};
let lastWaiting = false;
const listeners = new Set<(next: RateLimitStatus) => void>();

function publish(): void {
  const snapshot: RateLimitStatus = {
    limited: status.limited,
    waiting: waiters.length > 0,
    retryInMs: status.retryInMs,
    cls: status.cls,
  };
  status = snapshot;
  lastWaiting = snapshot.waiting;
  listeners.forEach((listener) => listener({ ...snapshot }));
}

function pump(): void {
  if (pumpTimer !== null) {
    clearTimeout(pumpTimer);
    pumpTimer = null;
  }
  const now = Date.now();
  let nextDelay = Number.POSITIVE_INFINITY;
  while (waiters.length > 0 && inFlight < MAX_CONCURRENCY) {
    const head = waiters[0];
    const wait = Math.max(
      waitFor(buckets.global, now),
      head.critical ? waitFor(buckets.critical, now) : 0,
    );
    if (wait > 0) {
      nextDelay = Math.min(nextDelay, wait);
      break;
    }
    waiters.shift();
    spend(buckets.global);
    if (head.critical) {
      spend(buckets.critical);
    }
    inFlight += 1;
    head.resolve();
  }
  if (nextDelay !== Number.POSITIVE_INFINITY) {
    pumpTimer = setTimeout(pump, Math.max(nextDelay, 1));
  }
  if (waiters.length > 0 !== lastWaiting) {
    publish();
  }
}

/** 拿到一个发送名额；预算不足时会等待，直到可以发出去为止。 */
export function acquireSlot(critical: boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    waiters.push({ critical, resolve });
    pump();
  });
}

export function releaseSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
  pump();
}

function startTicker(): void {
  if (ticker !== null) {
    return;
  }
  const tick = () => {
    ticker = null;
    const now = Date.now();
    const remaining = Math.max(
      0,
      Math.max(buckets.global.blockedUntil, buckets.critical.blockedUntil) - now,
    );
    if (remaining <= 0) {
      if (status.limited) {
        status = { ...status, limited: false, retryInMs: null, cls: null };
        publish();
      }
      return;
    }
    status = { ...status, retryInMs: remaining };
    publish();
    startTicker();
  };
  ticker = setTimeout(tick, 1000);
}

/**
 * 记录一次 429，返回调用方应当等待的毫秒数。清空令牌桶是为了把服务端已经
 * 烧掉的预算算进来，否则队列会立刻重放同一批请求再撞一次墙。
 */
export function noteLimited(cls: RateLimitClass, retryAfterMs: number | null): number {
  const bucket = buckets[cls];
  const now = Date.now();
  refill(bucket, now);
  bucket.tokens = 0;
  const wait = Math.min(
    Math.max(retryAfterMs ?? BLOCKED_FALLBACK_MS[cls], 1_000),
    BLOCKED_CEILING_MS[cls],
  );
  bucket.blockedUntil = now + wait;
  // 关键路由被限流时，同一轮的全局预算也已经被烧掉了。
  if (cls === 'critical') {
    refill(buckets.global, now);
    buckets.global.tokens = 0;
    buckets.global.blockedUntil = Math.max(
      buckets.global.blockedUntil,
      now + Math.min(wait, BLOCKED_CEILING_MS.global),
    );
  }
  status = { ...status, limited: true, retryInMs: wait, cls };
  publish();
  startTicker();
  return wait;
}

/** 有请求正常返回，按住解除后切回正常态。 */
export function noteServed(): void {
  const now = Date.now();
  const stillLimited = buckets.global.blockedUntil > now || buckets.critical.blockedUntil > now;
  if (status.limited && !stillLimited) {
    status = { ...status, limited: false, retryInMs: null, cls: null };
    publish();
  }
}

export function subscribeRateLimit(listener: (next: RateLimitStatus) => void): () => void {
  listeners.add(listener);
  listener({ ...status });
  return () => {
    listeners.delete(listener);
  };
}

export function rateLimitStatus(): RateLimitStatus {
  return { ...status };
}
