/**
 * 预算调度是模块级单例：每个用例都重新 require 一份，避免令牌桶和
 * 并发计数从一个测试漏到下一个测试里。
 */
type RateLimitModule = typeof import('../src/rate-limit');

let rl: RateLimitModule;

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-01T00:00:00Z').getTime());
  jest.resetModules();
  rl = jest.requireActual<RateLimitModule>('../src/rate-limit');
});

afterEach(() => {
  jest.useRealTimers();
});

/** 把微任务队列跑空，让 resolve 后的 then 回调有机会执行。 */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

describe('rate-limit', () => {
  test('并发上限内的请求立刻放行', async () => {
    const granted: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      void rl.acquireSlot(false).then(() => granted.push(i));
    }
    await drain();
    expect(granted).toHaveLength(3);
    expect(rl.rateLimitStatus().waiting).toBe(false);
  });

  test('超出并发上限后排队，腾出名额才放行', async () => {
    const granted: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      void rl.acquireSlot(false).then(() => granted.push(i));
    }
    await drain();
    expect(granted).toHaveLength(3);
    expect(rl.rateLimitStatus().waiting).toBe(true);

    rl.releaseSlot();
    await drain();
    expect(granted).toHaveLength(4);
  });

  test('令牌桶耗尽后按窗口速率放行', async () => {
    const granted: number[] = [];
    // 桶容量 15、并发上限 3：一次只放 3 个，其余按回填节奏陆续放行。
    for (let i = 0; i < 16; i += 1) {
      void rl.acquireSlot(false).then(() => granted.push(i));
    }
    await drain();
    expect(granted).toHaveLength(3);
    expect(rl.rateLimitStatus().waiting).toBe(true);

    granted.forEach(() => rl.releaseSlot());
    await drain();
    // 预算 360 次 / 180 秒的 75%：回填一个名额约需 0.67 秒。
    await jest.advanceTimersByTimeAsync(1_000);
    expect(granted.length).toBeGreaterThan(3);
    expect(granted.length).toBeLessThan(16);
  });

  test('服务端 429 会清空预算并按住后续请求', async () => {
    const seen: boolean[] = [];
    const unsubscribe = rl.subscribeRateLimit((next) => seen.push(next.limited));

    rl.noteLimited('global', 5_000);
    expect(rl.rateLimitStatus().limited).toBe(true);
    expect(rl.rateLimitStatus().cls).toBe('global');

    let granted = false;
    void rl.acquireSlot(false).then(() => {
      granted = true;
    });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(granted).toBe(false);

    await jest.advanceTimersByTimeAsync(4_000);
    expect(granted).toBe(true);
    rl.releaseSlot();

    // 按住解除后，一次正常响应把提示切回正常态。
    rl.noteServed();
    expect(rl.rateLimitStatus().limited).toBe(false);
    expect(seen).toContain(true);
    unsubscribe();
  });

  test('关键路由被限流会连带按住全局预算', async () => {
    rl.noteLimited('critical', 10_000);
    let granted = false;
    void rl.acquireSlot(false).then(() => {
      granted = true;
    });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(granted).toBe(false);
    expect(rl.rateLimitStatus().cls).toBe('critical');

    // 关键档上限 300 秒，但全局只按住 30 秒：普通请求先恢复。
    await jest.advanceTimersByTimeAsync(30_000);
    expect(granted).toBe(true);
  });
});
