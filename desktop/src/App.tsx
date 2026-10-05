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
  const refreshingRef = useRef(false);
  const refreshQueuedRef = useRef(false);

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
      setSession((prev) => {
        const next = loadSession();
        if (prev && next && isSameAccount(prev, next)) {
          return prev;
        }
        return next;
      });
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
    try {
      const activeAccountId = accountIdOf(session);
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
    } catch (loadError) {
      if (loadError instanceof SessionExpiredError) {
        resetDashboardData();
        setSession(loadSession());
        setAccounts(listAccounts());
        setError(loadError.message);
        return;
      }
      if (loadError instanceof RateLimitError && hasDataRef.current) {
        // 429 只说明这一轮刷新被限流，看板里已有的数据仍然准确：保留它并稍后重试
        message.warning('站点接口限流（429），已保留上一次数据，稍后自动重试');
        scheduleRateLimitRetry();
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

  function scheduleRateLimitRetry() {
    if (!loadSession() || rateLimitRetryRef.current !== null) {
      return;
    }
    rateLimitRetryRef.current = window.setTimeout(() => {
      rateLimitRetryRef.current = null;
      if (loadSession()) {
        void loadDashboard();
      }
    }, 12_000);
  }

  useEffect(() => {
    if (session) {
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

  function handleLoggedIn() {
    setAddingAccount(false);
    setSession(loadSession());
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
    setSession(loadSession());
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
      resetDashboardData();
      setSession(loadSession());
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
      onRefresh={() => void loadDashboard()}
      onSwitchAccount={handleSwitchAccount}
      onRemoveAccount={handleRemoveAccount}
      onAddAccount={handleAddAccount}
      onOpenFloatingWindow={() => void handleOpenFloatingWindow()}
    />
  );
}

export default App;
