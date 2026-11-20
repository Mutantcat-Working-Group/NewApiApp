import AsyncStorage from '@react-native-async-storage/async-storage';
import { cacheKey, clearCachePrefix, formatCacheAge, readCache, writeCache } from '../src/cache';

type FakeStorage = {
  map: Map<string, string>;
  failNextSet: boolean;
};

/**
 * AsyncStorage 在 node 环境下没有实现，这里换成一张内存表；
 * 用例之间通过 __reset 恢复干净状态。
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  const state: FakeStorage = { map: new Map(), failNextSet: false };
  return {
    __esModule: true,
    default: {
      __reset: () => {
        state.map.clear();
        state.failNextSet = false;
      },
      __state: state,
      getItem: (key: string) => Promise.resolve(state.map.get(key) ?? null),
      setItem: (key: string, value: string) => {
        if (state.failNextSet) {
          state.failNextSet = false;
          return Promise.reject(new Error('quota exceeded'));
        }
        state.map.set(key, value);
        return Promise.resolve();
      },
      removeItem: (key: string) => {
        state.map.delete(key);
        return Promise.resolve();
      },
      getAllKeys: () => Promise.resolve([...state.map.keys()]),
    },
  };
});

const fake = AsyncStorage as unknown as {
  __reset: () => void;
  __state: FakeStorage;
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-01T00:00:00Z').getTime());
  fake.__reset();
});

afterEach(() => {
  jest.useRealTimers();
});

test('key 按账号隔离', () => {
  expect(cacheKey('a|b', 'dashboard')).toBe('newapi.cache.v1:a|b:dashboard');
});

test('写入后可以读回，并带上保存时间', async () => {
  await writeCache(cacheKey('acct', 'dashboard'), { quota: 42 });
  const entry = await readCache<{ quota: number }>(cacheKey('acct', 'dashboard'));
  expect(entry?.data.quota).toBe(42);
  expect(entry?.savedAt).toBe(Date.now());
});

test('没有缓存或缓存损坏时返回 null', async () => {
  expect(await readCache(cacheKey('acct', 'dashboard'))).toBeNull();

  fake.__state.map.set(cacheKey('acct', 'dashboard'), '{ 不是 JSON');
  expect(await readCache(cacheKey('acct', 'dashboard'))).toBeNull();

  fake.__state.map.set(cacheKey('acct', 'dashboard'), JSON.stringify({ data: 1 }));
  expect(await readCache(cacheKey('acct', 'dashboard'))).toBeNull();
});

test('存储抛错时写入失败被吞掉', async () => {
  fake.__state.failNextSet = true;
  await expect(writeCache(cacheKey('acct', 'dashboard'), { quota: 1 })).resolves.toBeUndefined();
  expect(await readCache(cacheKey('acct', 'dashboard'))).toBeNull();
});

test('连写时后写的快照生效', async () => {
  void writeCache(cacheKey('acct', 'dashboard'), { quota: 1 });
  void writeCache(cacheKey('acct', 'dashboard'), { quota: 2 });
  await writeCache(cacheKey('acct', 'dashboard'), { quota: 3 });
  const entry = await readCache<{ quota: number }>(cacheKey('acct', 'dashboard'));
  expect(entry?.data.quota).toBe(3);
});

test('清理只删掉指定账号的缓存', async () => {
  await writeCache(cacheKey('acctA', 'dashboard'), 1);
  await writeCache(cacheKey('acctB', 'dashboard'), 2);
  await clearCachePrefix('acctA');
  expect(await readCache(cacheKey('acctA', 'dashboard'))).toBeNull();
  expect(await readCache(cacheKey('acctB', 'dashboard'))).not.toBeNull();
});

test('缓存年龄按秒/分/小时/天显示', () => {
  const now = Date.now();
  expect(formatCacheAge(now)).toBe('0 秒前');
  expect(formatCacheAge(now - 30_000)).toBe('30 秒前');
  expect(formatCacheAge(now - 5 * 60_000)).toBe('5 分钟前');
  expect(formatCacheAge(now - 3 * 3_600_000)).toBe('3 小时前');
  expect(formatCacheAge(now - 2 * 86_400_000)).toBe('2 天前');
});
