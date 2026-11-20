/**
 * 上一次成功读到的看板数据。站点限流或预算排队时先把它显示出来，
 * 让界面不会因为拿不到新数据就变空。
 */

export type CacheEntry<T> = {
  savedAt: number;
  data: T;
};

const PREFIX = 'newapi.cache.v1:';

export function cacheKey(accountId: string, name: string): string {
  return `${PREFIX}${accountId}:${name}`;
}

export function readCache<T>(key: string): CacheEntry<T> | null {
  const raw = localStorage.getItem(key);
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

export function writeCache<T>(key: string, data: T): void {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // 超出配额时放弃缓存，不影响主流程。
  }
}

export function clearCachePrefix(accountId: string): void {
  const prefix = `${PREFIX}${accountId}:`;
  const stale: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(prefix)) {
      stale.push(key);
    }
  }
  stale.forEach((key) => localStorage.removeItem(key));
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
