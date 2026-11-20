import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfigProvider, message } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen } from '@tauri-apps/api/event';
import Dashboard from './components/Dashboard';
import FloatingBalance from './components/FloatingBalance';
import LoginCard from './components/LoginCard';
import { useSleepWatchdog } from './hooks/useSleepWatchdog';
import {
  NewApiClient,
  RateLimitError,
  SessionExpiredError,
  accountIdOf,
  isSameAccount,
  listAccounts,
  loadSession,
  loadSessionById,
  removeAccount,
  setActiveAccount,
  storeSession,
  sessionsEqual,
} from './api';
import type { StoredSession } from './api';
import { cacheKey, readCache, writeCache, clearCachePrefix } from './cache';
import { subscribeRateLimit } from './rate-limit';
import type { RateLimitStatus } from './rate-limit';
import type {
  CheckinStatus,
  GroupInfo,
  LogItem,
  LogStat,
  NewApiStatus,
  QuotaDateItem,
  SelfUser,
  SubscriptionPlan,
  SubscriptionSelf,
  TokenItem,
  TopUpInfo,
  TopUpItem,
} from './types';

/** 一次成功刷新后落盘的看板快照，限流或排队时用它继续显示。 */
type DashboardSnapshot = {
  status: NewApiStatus | null;
  user: SelfUser | null;
  logStat: LogStat | null;
  tokens: TokenItem[];
  notice: string;
  groups: Record<string, GroupInfo>;
  models: string[];
  quotaDates: QuotaDateItem[];
  usageLogs: LogItem[];
  topUpInfo: TopUpInfo | null;
  topUps: TopUpItem[];
  checkin: CheckinStatus | null;
  subscriptionPlans: SubscriptionPlan[];
  subscriptionSelf: SubscriptionSelf | null;
  affCode: string;
};

const SNAPSHOT_NAME = 'dashboard';

function readSnapshot(accountId: string): { savedAt: number; data: DashboardSnapshot } | null {
  return readCache<DashboardSnapshot>(cacheKey(accountId, SNAPSHOT_NAME));
}

function currentWindowLabel(): string | null {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return null;
  }
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return null;
  }
}

function App() {
  const isBalanceWindow = currentWindowLabel() === 'balance';

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#2f6fed',
          borderRadius: 8,
        },
      }}
    >
      {isBalanceWindow ? <FloatingBalance /> : <MainApp />}
    </ConfigProvider>
  );
}

function MainApp() {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession());
  const [accounts, setAccounts] = useState<StoredSession[]>(() => listAccounts());
  const [addingAccount, setAddingAccount] = useState(false);
  const [status, setStatus] = useState<NewApiStatus | null>(null);
  const [user, setUser] = useState<SelfUser | null>(null);
  const [logStat, setLogStat] = useState<LogStat | null>(null);
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [notice, setNotice] = useState('');
  const [groups, setGroups] = useState<Record<string, GroupInfo>>({});
  const [models, setModels] = useState<string[]>([]);
  const [quotaDates, setQuotaDates] = useState<QuotaDateItem[]>([]);
  const [usageLogs, setUsageLogs] = useState<LogItem[]>([]);
  const [topUpInfo, setTopUpInfo] = useState<TopUpInfo | null>(null);
  const [topUps, setTopUps] = useState<TopUpItem[]>([]);
  const [checkin, setCheckin] = useState<CheckinStatus | null>(null);
  const [subscriptionPlans, setSubscriptionPlans] = useState<SubscriptionPlan[]>([]);
  const [subscriptionSelf, setSubscriptionSelf] = useState<SubscriptionSelf | null>(null);
  const [affCode, setAffCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingExtras, setLoadingExtras] = useState(false);
  const [error, setError] = useState('');
  /** True once the dashboard holds real data, so a 429 can keep showing it. */
  const hasDataRef = useRef(false);
  const rateLimitRetryRef = useRef<number | null>(null);
  /** Grows while the site keeps refusing, so a ban is not probed on a fixed cadence. */
  const rateLimitBackoffRef = useRef(12_000);
  const refreshingRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  /** 界面正在显示的这份数据是什么时候从站点拿到的，null 表示还没有任何数据。 */
  const [dataSavedAt, setDataSavedAt] = useState<number | null>(null);
  const [rateLimit, setRateLimit] = useState<RateLimitStatus | null>(null);
  /** 每次成功加载自增，触发落盘（effect 里读到的是已经提交的最新 state）。 */
  const [persistTick, setPersistTick] = useState(0);
  /** 跨窗口切换时对比用：监听回调里拿不到最新的 session state。 */
  const sessionRef = useRef<StoredSession | null>(loadSession());

  useEffect(() => subscribeRateLimit(setRateLimit), []);

  /** 把缓存里的快照铺回界面。限流时界面显示的就是这份数据，并带降级提示。 */
  const applySnapshot = useCallback((snapshot: DashboardSnapshot) => {
    setStatus(snapshot.status);
    setUser(snapshot.user);
    setLogStat(snapshot.logStat);
    setTokens(snapshot.tokens);
    setNotice(snapshot.notice);
    setGroups(snapshot.groups);
    setModels(snapshot.models);
    setQuotaDates(snapshot.quotaDates);
    setUsageLogs(snapshot.usageLogs);
    setTopUpInfo(snapshot.topUpInfo);
    setTopUps(snapshot.topUps);
    setCheckin(snapshot.checkin);
    setSubscriptionPlans(snapshot.subscriptionPlans);
    setSubscriptionSelf(snapshot.subscriptionSelf);
    setAffCode(snapshot.affCode);
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen('accounts-changed', () => {
      if (disposed) {
        return;
      }
      const nextAccounts = listAccounts();
      setAccounts((prev) =>
        prev.length === nextAccounts.length &&
        prev.every((item, i) => sessionsEqual(item, nextAccounts[i] ?? item))
          ? prev
          : nextAccounts,
      );
      // The window tracks which account is active; a token rotated in the
      // background is the same account, and re-rendering it would restart
      // the dashboard load that produced the write.
      const previous = sessionRef.current;
      const next = loadSession();
      sessionRef.current = next;
      if (previous && next && isSameAccount(previous, next)) {
        return;
      }
      // 另一个窗口换了账号或退出了：旧账号的数据（以及它的缓存降级提示）
      // 不能留在界面上。
      if (previous && !(next && isSameAccount(previous, next))) {
        resetDashboardData();
      }
      setSession(next);
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  function resetDashboardData() {
    hasDataRef.current = false;
    setDataSavedAt(null);
    setStatus(null);
    setUser(null);
    setLogStat(null);
    setTokens([]);
    setNotice('');
    setGroups({});
    setModels([]);
    setQuotaDates([]);
    setUsageLogs([]);
    setTopUpInfo(null);
    setTopUps([]);
    setCheckin(null);
    setSubscriptionPlans([]);
    setSubscriptionSelf(null);
    setAffCode('');
    setError('');
  }

  const loadExtras = useCallback(async (client: NewApiClient) => {
    const ignore = (err: unknown) => {
      if (err instanceof SessionExpiredError) {
        throw err;
      }
      // 附加数据按站点能力可选加载，单项失败不阻塞看板
    };

    setLoadingExtras(true);
    try {
      await Promise.all([
        client.getNotice().then(setNotice).catch(ignore),
        client.getGroups().then(setGroups).catch(ignore),
        client.getUserModels().then(setModels).catch(ignore),
        client
          .getQuotaDates(
            Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60,
            Math.floor(Date.now() / 1000),
          )
          .then(setQuotaDates)
          .catch(ignore),
        client.getUsageLogs(1, 30).then((result) => setUsageLogs(result.items ?? [])).catch(ignore),
        client.getTopUpInfo().then(setTopUpInfo).catch(ignore),
        client.getTopUpHistory(1, 20).then((result) => setTopUps(result.items ?? [])).catch(ignore),
        client.getCheckinStatus().then(setCheckin).catch(ignore),
        client.getSubscriptionPlans().then(setSubscriptionPlans).catch(ignore),
        client.getSubscriptionSelf().then(setSubscriptionSelf).catch(ignore),
        client.getAffCode().then(setAffCode).catch(ignore),
      ]);
    } finally {
      setLoadingExtras(false);
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    if (!session) {
      return;
    }
    if (refreshingRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshingRef.current = true;
    setLoading(true);
    setError('');
    if (rateLimitRetryRef.current !== null) {
      window.clearTimeout(rateLimitRetryRef.current);
      rateLimitRetryRef.current = null;
    }
    const activeAccountId = accountIdOf(session);
    // 冷启动先铺缓存：还没有任何数据时，站点限流不该让界面空着。
    if (!hasDataRef.current) {
      const cached = readSnapshot(activeAccountId);
      if (cached) {
        applySnapshot(cached.data);
        setDataSavedAt(cached.savedAt);
      }
    }
    try {
      const activeClient = new NewApiClient(session.baseUrl, activeAccountId);
      const [nextStatus, nextUser, nextTokens, nextStat] = await Promise.all([
        activeClient.getStatus(),
        activeClient.getSelf(),
        activeClient.getTokens(),
        activeClient.getSelfLogStat(),
      ]);
      setStatus(nextStatus);
      setUser(nextUser);
      setTokens(nextTokens);
      setLogStat(nextStat);
      hasDataRef.current = true;
      setDataSavedAt(null);
      rateLimitBackoffRef.current = 12_000;
      await loadExtras(activeClient);
      // Merge into whatever is stored now: a refresh triggered by one of the
      // requests above may have rotated the tokens, and this snapshot is stale.
      const stored = loadSessionById(activeAccountId);
      if (stored) {
        const merged = { ...stored, user: nextUser };
        if (!sessionsEqual(stored, merged)) {
          storeSession(merged);
        }
      }
      // 记号推进后，下面的 effect 会把这个账号的新快照写进磁盘缓存。
      setPersistTick((t) => t + 1);
    } catch (loadError) {
      if (loadError instanceof SessionExpiredError) {
        resetDashboardData();
        setSession(loadSession());
        setAccounts(listAccounts());
        setError(loadError.message);
        return;
      }
      if (loadError instanceof RateLimitError) {
        // 429 只说明这一轮刷新被限流，看板里已有的数据仍然准确：保留它并稍后重试
        if (hasDataRef.current) {
          message.warning('站点接口限流（429），已保留上一次数据，稍后自动重试');
        }
        // 连缓存都没有时也继续重试，直到真正拿到数据为止
        scheduleRateLimitRetry(loadError.retryAfterMs);
        return;
      }
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      refreshingRef.current = false;
      const stillLoggedIn = Boolean(loadSession());
      if (refreshQueuedRef.current && stillLoggedIn) {
        refreshQueuedRef.current = false;
        void loadDashboard();
      } else {
        refreshQueuedRef.current = false;
        setLoading(false);
      }
    }
  }, [session]);

  // 每次成功刷新后把看板快照落盘；下次冷启动或限流时用它顶着。
  useEffect(() => {
    if (!session || persistTick === 0) {
      return;
    }
    const snapshot: DashboardSnapshot = {
      status,
      user,
      logStat,
      tokens,
      notice,
      groups,
      models,
      quotaDates,
      usageLogs,
      topUpInfo,
      topUps,
      checkin,
      subscriptionPlans,
      subscriptionSelf,
      affCode,
    };
    writeCache(cacheKey(accountIdOf(session), SNAPSHOT_NAME), snapshot);
  }, [
    persistTick,
    session,
    status,
    user,
    logStat,
    tokens,
    notice,
    groups,
    models,
    quotaDates,
    usageLogs,
    topUpInfo,
    topUps,
    checkin,
    subscriptionPlans,
    subscriptionSelf,
    affCode,
  ]);

  function scheduleRateLimitRetry(retryAfterMs: number | null) {
    if (!loadSession() || rateLimitRetryRef.current !== null) {
      return;
    }
    // 服务端给了 Retry-After 就照它的时间等，否则用客户端自己的退避节奏。
    const delay =
      retryAfterMs !== null ? Math.max(retryAfterMs, 3_000) : rateLimitBackoffRef.current;
    rateLimitRetryRef.current = window.setTimeout(() => {
      rateLimitRetryRef.current = null;
      if (loadSession()) {
        void loadDashboard();
      }
    }, Math.min(delay, 120_000));
    // Still limited? Ask again later, not again soon.
    rateLimitBackoffRef.current = Math.min(rateLimitBackoffRef.current * 2, 60_000);
  }

  useEffect(() => {
    if (session) {
      // A different account is a different quota bucket: start over politely.
      rateLimitBackoffRef.current = 12_000;
      void loadDashboard();
    } else if (rateLimitRetryRef.current !== null) {
      window.clearTimeout(rateLimitRetryRef.current);
      rateLimitRetryRef.current = null;
    }
    return () => {
      if (rateLimitRetryRef.current !== null) {
        window.clearTimeout(rateLimitRetryRef.current);
        rateLimitRetryRef.current = null;
      }
    };
  }, [session, loadDashboard]);

  useSleepWatchdog({
    onResume: () => {
      if (session) {
        void loadDashboard();
      }
    },
  });

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  function handleLoggedIn() {
    setAddingAccount(false);
    const next = loadSession();
    sessionRef.current = next;
    setSession(next);
    setAccounts(listAccounts());
  }

  function handleCancelAddAccount() {
    setAddingAccount(false);
    setError('');
  }

  function handleAddAccount() {
    setAddingAccount(true);
    setError('');
  }

  function handleSwitchAccount(accountId: string) {
    setActiveAccount(accountId);
    resetDashboardData();
    const next = loadSession();
    sessionRef.current = next;
    setSession(next);
    setAccounts(listAccounts());
  }

  function handleRemoveAccount(accountId: string) {
    void (async () => {
      const target = listAccounts().find((item) => accountIdOf(item) === accountId);
      if (target) {
        await new NewApiClient(target.baseUrl, accountId).logout();
      } else {
        removeAccount(accountId);
      }
      clearCachePrefix(accountId);
      resetDashboardData();
      const next = loadSession();
      sessionRef.current = next;
      setSession(next);
      setAccounts(listAccounts());
    })();
  }

  async function handleOpenFloatingWindow() {
    try {
      const existing = await WebviewWindow.getByLabel('balance');
      if (existing) {
        await existing.show();
        await existing.setAlwaysOnTop(true);
        return;
      }
      const floatingWindow = new WebviewWindow('balance', {
        url: 'index.html',
        width: 260,
        height: 126,
        resizable: false,
        decorations: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        title: 'NewApiApp Balance',
      });
      floatingWindow.once('tauri://error', (event) => {
        message.error(`Failed to open floating window: ${String(event.payload)}`);
      });
    } catch (openError) {
      message.error(openError instanceof Error ? openError.message : String(openError));
    }
  }

  if (!session || addingAccount) {
    return (
      <LoginCard
        onLoggedIn={handleLoggedIn}
        onCancel={addingAccount && session ? handleCancelAddAccount : undefined}
        notice={error}
        accounts={accounts}
        activeAccountId={session ? accountIdOf(session) : null}
        onSwitchAccount={handleSwitchAccount}
      />
    );
  }

  return (
    <Dashboard
      session={session}
      accounts={accounts}
      activeAccountId={accountIdOf(session)}
      status={status}
      user={user}
      logStat={logStat}
      tokens={tokens}
      notice={notice}
      groups={groups}
      models={models}
      quotaDates={quotaDates}
      usageLogs={usageLogs}
      topUpInfo={topUpInfo}
      topUps={topUps}
      checkin={checkin}
      subscriptionPlans={subscriptionPlans}
      subscriptionSelf={subscriptionSelf}
      affCode={affCode}
      loading={loading}
      loadingExtras={loadingExtras}
      error={error}
      dataSavedAt={dataSavedAt}
      rateLimit={rateLimit}
      onRefresh={() => void loadDashboard()}
      onSwitchAccount={handleSwitchAccount}
      onRemoveAccount={handleRemoveAccount}
      onAddAccount={handleAddAccount}
      onOpenFloatingWindow={() => void handleOpenFloatingWindow()}
    />
  );
}

export default App;
