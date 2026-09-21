import { useCallback, useEffect, useState } from 'react';
import { ConfigProvider, message } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow';
import Dashboard from './components/Dashboard';
import FloatingBalance from './components/FloatingBalance';
import LoginCard from './components/LoginCard';
import { NewApiClient, SessionExpiredError, loadSession, saveSession } from './api';
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
    setLoading(true);
    setError('');
    try {
      const activeClient = new NewApiClient(session.baseUrl);
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
      await loadExtras(activeClient);
      // Merge into whatever is stored now: a refresh triggered by one of the
      // requests above may have rotated the tokens, and this snapshot is stale.
      const stored = loadSession();
      if (stored) {
        saveSession({ ...stored, user: nextUser });
      }
    } catch (loadError) {
      if (loadError instanceof SessionExpiredError) {
        saveSession(null);
        setSession(null);
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
        setError(loadError.message);
        return;
      }
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    if (session) {
      void loadDashboard();
    }
  }, [session, loadDashboard]);

  function handleLoggedIn() {
    setSession(loadSession());
  }

  async function handleLogout() {
    if (session) {
      await new NewApiClient(session.baseUrl).logout();
    }
    setSession(null);
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
        height: 112,
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

  if (!session) {
    return <LoginCard onLoggedIn={handleLoggedIn} notice={error} />;
  }

  return (
    <Dashboard
      session={session}
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
      onLogout={handleLogout}
      onOpenFloatingWindow={() => void handleOpenFloatingWindow()}
    />
  );
}

export default App;
