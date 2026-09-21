import { useCallback, useEffect, useState } from 'react';
import { ConfigProvider, message } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow';
import Dashboard from './components/Dashboard';
import FloatingBalance from './components/FloatingBalance';
import LoginCard from './components/LoginCard';
import { NewApiClient, SessionExpiredError, loadSession, saveSession } from './api';
import type { StoredSession } from './api';
import type { LogStat, NewApiStatus, SelfUser, TokenItem } from './types';

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
      loading={loading}
      error={error}
      onRefresh={() => void loadDashboard()}
      onLogout={handleLogout}
      onOpenFloatingWindow={() => void handleOpenFloatingWindow()}
    />
  );
}

export default App;
