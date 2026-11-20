/**
 * 上一次成功读到的看板数据。站点限流或预算排队时先把它显示出来，
 * 让界面不会因为拿不到新数据就变空。
 *
 * 移动端用 AsyncStorage，读写都是异步的，所以写入串行化：两次刷新接连落盘时
 * 后写的不能覆盖先写的（AsyncStorage 的读改写没有锁）。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export type CacheEntry<T> = {
  savedAt: number;
  data: T;
};

const PREFIX = 'newapi.cache.v1:';

export function cacheKey(accountId: string, name: string): string {
  return `${PREFIX}${accountId}:${name}`;
}

export async function readCache<T>(key: string): Promise<CacheEntry<T> | null> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (parsed && typeof parsed.savedAt === 'number' && 'data' in parsed) {
      return parsed;
    }
  } catch {
    // 缓存坏了就当作没有，不能让它挡住正常加载。
  }
  return null;
}

/** 写队列：保证同一时刻只有一个 setItem 在跑，避免旧快照盖掉新快照。 */
let writeChain: Promise<void> = Promise.resolve();

export function writeCache<T>(key: string, data: T): Promise<void> {
  const payload = JSON.stringify({ savedAt: Date.now(), data });
  writeChain = writeChain.then(async () => {
    try {
      await AsyncStorage.setItem(key, payload);
    } catch {
      // 超出配额时放弃缓存，不影响主流程。
    }
  });
  return writeChain;
}

export async function clearCachePrefix(accountId: string): Promise<void> {
  const prefix = `${PREFIX}${accountId}:`;
  try {
    const keys = await AsyncStorage.getAllKeys();
    const stale = keys.filter((key) => key.startsWith(prefix));
    await Promise.all(stale.map((key) => AsyncStorage.removeItem(key)));
  } catch {
    // 清理失败不影响主流程：缓存以账号为前缀，不会被别的账号读到。
  }
}

export function formatCacheAge(savedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
  if (seconds < 60) {
    return `${seconds} 秒前`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  return `${Math.floor(hours / 24)} 天前`;
}
