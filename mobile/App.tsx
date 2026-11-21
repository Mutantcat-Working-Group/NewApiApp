// NewApiApp mobile — 由异猫工作群（mutantcat.org）发行
// GitHub: https://github.com/Mutantcat-Working-Group
/**
 * NewApiApp - new-api relay panel client (mobile)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import DashboardScreen from './src/components/DashboardScreen';
import LoginForm from './src/components/LoginForm';
import {
  NewApiClient,
  RateLimitError,
  SessionExpiredError,
  accountIdOf,
  listAccounts,
  loadSession,
  loadSessionById,
  removeAccount,
  setActiveAccount,
  storeSession,
  sessionsEqual,
  summarizeUsage,
} from './src/api';
import type { StoredSession } from './src/api';
import { cacheKey, clearCachePrefix, readCache, writeCache } from './src/cache';
import { subscribeRateLimit } from './src/rate-limit';
import type { RateLimitStatus } from './src/rate-limit';
import type { LogStat, NewApiStatus, SelfUser, TokenItem, UsageSummary } from './src/types';
import { colors } from './src/theme';

/** 一次成功刷新后落盘的看板快照，限流或排队时用它继续显示。 */
type DashboardSnapshot = {
  status: NewApiStatus | null;
  user: SelfUser | null;
  logStat: LogStat | null;
  usage: UsageSummary | null;
  tokens: TokenItem[];
};

const SNAPSHOT_NAME = 'dashboard';

/** 限流重试的最大间隔；服务端给的 Retry-After 通常比这个小。 */
const MAX_RETRY_DELAY_MS = 120_000;

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [accounts, setAccounts] = useState<StoredSession[]>([]);
  const [addingAccount, setAddingAccount] = useState(false);
  const [booting, setBooting] = useState(true);
  const [status, setStatus] = useState<NewApiStatus | null>(null);
  const [user, setUser] = useState<SelfUser | null>(null);
  const [logStat, setLogStat] = useState<LogStat | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** 界面上的数据取自缓存时的时间戳；null 表示当前显示的是实时数据。 */
  const [dataSavedAt, setDataSavedAt] = useState<number | null>(null);
  const [rateLimit, setRateLimit] = useState<RateLimitStatus | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTokenRef = useRef(0);
  /** 看板上是否已经有数据；只在真的空着时才用缓存铺底，避免旧快照盖掉新数据。 */
  const hasDataRef = useRef(false);

  useEffect(() => subscribeRateLimit(setRateLimit), []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const resetDashboard = useCallback(() => {
    hasDataRef.current = false;
    setStatus(null);
    setUser(null);
    setLogStat(null);
    setUsage(null);
    setTokens([]);
    setDataSavedAt(null);
    setError('');
  }, []);

  const loadDashboard = useCallback(
    async (activeSession: StoredSession) => {
      const activeAccountId = accountIdOf(activeSession);
      refreshTokenRef.current += 1;
      const ticket = refreshTokenRef.current;
      clearRetryTimer();
      setLoading(true);
      setError('');
      // 冷启动先铺缓存：站点限流不该让界面空着。已有数据时不用旧快照覆盖。
      if (!hasDataRef.current) {
        const cached = await readCache<DashboardSnapshot>(
          cacheKey(activeAccountId, SNAPSHOT_NAME),
        );
        if (cached && ticket === refreshTokenRef.current && !hasDataRef.current) {
          setStatus(cached.data.status);
          setUser(cached.data.user);
          setLogStat(cached.data.logStat);
          setUsage(cached.data.usage ?? null);
          setTokens(cached.data.tokens);
          setDataSavedAt(cached.savedAt);
        }
      }
      try {
        const client = new NewApiClient(activeSession.baseUrl, activeAccountId);
        const now = Math.floor(Date.now() / 1000);
        const dayAgo = now - 24 * 60 * 60;
        const [nextStatus, nextUser, nextTokens, nextStat, nextQuotaDates] = await Promise.all([
          client.getStatus(),
          client.getSelf(),
          client.getTokens(),
          client.getSelfLogStat(),
          // 服务端不提供“近 24 小时 token / 请求次数”的现成字段，只能自己按小时行合计。
          // 站点禁用该接口时不影响其它卡片，但限流与会话失效必须照样抛出去。
          client.getQuotaDates(dayAgo, now).catch((extraError: unknown) => {
            if (extraError instanceof RateLimitError || extraError instanceof SessionExpiredError) {
              throw extraError;
            }
            // null 表示这一项拿不到，卡片显示 “-”，不要伪装成 0。
            return null;
          }),
        ]);
        if (ticket !== refreshTokenRef.current) {
          // 期间切了账号：这一批结果已经不属于当前界面。
          return;
        }
        const nextUsage = nextQuotaDates ? summarizeUsage(nextQuotaDates, dayAgo) : null;
        setStatus(nextStatus);
        setUser(nextUser);
        setTokens(nextTokens);
        setLogStat(nextStat);
        setUsage(nextUsage);
        setDataSavedAt(null);
        hasDataRef.current = true;
        void writeCache<DashboardSnapshot>(cacheKey(activeAccountId, SNAPSHOT_NAME), {
          status: nextStatus,
          user: nextUser,
          logStat: nextStat,
          usage: nextUsage,
          tokens: nextTokens,
        });
        // Merge into whatever is stored now: a refresh triggered by one of the
        // requests above may have rotated the tokens, and this snapshot is stale.
        const stored = await loadSessionById(activeAccountId);
        if (stored && ticket === refreshTokenRef.current) {
          const merged = { ...stored, user: nextUser };
          if (!sessionsEqual(stored, merged)) {
            await storeSession(merged);
          }
        }
      } catch (loadError) {
        if (ticket !== refreshTokenRef.current) {
          return;
        }
        if (loadError instanceof SessionExpiredError) {
          const [nextSession, savedAccounts] = await Promise.all([
            loadSession(),
            listAccounts(),
          ]);
          setSession(nextSession);
          setAccounts(savedAccounts);
          resetDashboard();
          setError('登录状态已失效，请重新登录');
          return;
        }
        if (loadError instanceof RateLimitError) {
          // 429 只说明这一轮被限流：保留界面上已有的（可能是缓存的）数据，稍后重试。
          setError('站点请求频率已到上限，当前显示的是上一次的数据');
          const delay = Math.min(
            loadError.retryAfterMs ?? 15_000,
            MAX_RETRY_DELAY_MS,
          );
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            void loadDashboard(activeSession);
          }, Math.max(delay, 3_000));
          return;
        }
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (ticket === refreshTokenRef.current) {
          setLoading(false);
        }
      }
    },
    [clearRetryTimer, resetDashboard],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      const [stored, savedAccounts] = await Promise.all([loadSession(), listAccounts()]);
      if (!active) {
        return;
      }
      setSession(stored);
      setAccounts(savedAccounts);
      setBooting(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (session) {
      void loadDashboard(session);
    }
  }, [session, loadDashboard]);

  // 回到前台时刷新：移动端进程会被挂起，定时器不可靠，靠这个事件补一次。
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && session) {
        void loadDashboard(session);
      }
    });
    return () => subscription.remove();
  }, [session, loadDashboard]);

  useEffect(() => clearRetryTimer, [clearRetryTimer]);

  const handleRefresh = useCallback(() => {
    if (!session || loading) {
      return;
    }
    void loadDashboard(session);
  }, [session, loading, loadDashboard]);

  const handleLogout = useCallback(() => {
    void (async () => {
      const activeId = session ? accountIdOf(session) : null;
      if (session) {
        await new NewApiClient(session.baseUrl, activeId ?? undefined).logout();
      }
      if (activeId) {
        await clearCachePrefix(activeId);
      }
      refreshTokenRef.current += 1;
      clearRetryTimer();
      const [nextSession, savedAccounts] = await Promise.all([loadSession(), listAccounts()]);
      setSession(nextSession);
      setAccounts(savedAccounts);
      resetDashboard();
    })();
  }, [session, clearRetryTimer, resetDashboard]);

  const handleLoggedIn = useCallback(() => {
    void (async () => {
      const [stored, savedAccounts] = await Promise.all([loadSession(), listAccounts()]);
      setAddingAccount(false);
      setSession(stored);
      setAccounts(savedAccounts);
    })();
  }, []);

  const handleSwitchAccount = useCallback(
    (accountId: string) => {
      void (async () => {
        await setActiveAccount(accountId);
        refreshTokenRef.current += 1;
        clearRetryTimer();
        const [stored, savedAccounts] = await Promise.all([loadSession(), listAccounts()]);
        setSession(stored);
        setAccounts(savedAccounts);
        resetDashboard();
      })();
    },
    [clearRetryTimer, resetDashboard],
  );

  const handleRemoveAccount = useCallback(
    (accountId: string) => {
      void (async () => {
        const target = (await listAccounts()).find((item) => accountIdOf(item) === accountId);
        if (target) {
          await new NewApiClient(target.baseUrl, accountId).logout();
        } else {
          await removeAccount(accountId);
        }
        await clearCachePrefix(accountId);
        refreshTokenRef.current += 1;
        clearRetryTimer();
        const [stored, savedAccounts] = await Promise.all([loadSession(), listAccounts()]);
        setSession(stored);
        setAccounts(savedAccounts);
        resetDashboard();
      })();
    },
    [clearRetryTimer, resetDashboard],
  );

  if (booting) {
    return <View style={styles.boot} />;
  }

  if (!session || addingAccount) {
    return (
      <LoginForm
        onLoggedIn={handleLoggedIn}
        onCancel={addingAccount && session ? () => setAddingAccount(false) : undefined}
        notice={error}
        accounts={accounts}
        activeAccountId={session ? accountIdOf(session) : null}
        onSwitchAccount={handleSwitchAccount}
      />
    );
  }

  return (
    <DashboardScreen
      session={session}
      status={status}
      user={user}
      logStat={logStat}
      usage={usage}
      tokens={tokens}
      accounts={accounts}
      activeAccountId={accountIdOf(session)}
      loading={loading}
      error={error}
      dataSavedAt={dataSavedAt}
      rateLimit={rateLimit}
      onRefresh={handleRefresh}
      onLogout={handleLogout}
      onSwitchAccount={handleSwitchAccount}
      onRemoveAccount={handleRemoveAccount}
      onAddAccount={() => {
        setAddingAccount(true);
        setError('');
      }}
    />
  );
}

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    backgroundColor: colors.background,
  },
});

export default App;
