// NewApiApp mobile — 由异猫工作群（mutantcat.org）发行
// GitHub: https://github.com/Mutantcat-Working-Group
/**
 * NewApiApp - new-api relay panel client (mobile)
 */

import { useCallback, useEffect, useState } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import DashboardScreen from './src/components/DashboardScreen';
import LoginForm from './src/components/LoginForm';
import {
  NewApiClient,
  SessionExpiredError,
  accountIdOf,
  listAccounts,
  loadSession,
  loadSessionById,
  removeAccount,
  setActiveAccount,
  storeSession,
} from './src/api';
import type { StoredSession } from './src/api';
import type { LogStat, NewApiStatus, SelfUser, TokenItem } from './src/types';
import { colors } from './src/theme';

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
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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

  const loadDashboard = useCallback(
    async (activeSession: StoredSession) => {
      setLoading(true);
      setError('');
      try {
        const activeAccountId = accountIdOf(activeSession);
        const client = new NewApiClient(activeSession.baseUrl, activeAccountId);
        const [nextStatus, nextUser, nextTokens, nextStat] = await Promise.all([
          client.getStatus(),
          client.getSelf(),
          client.getTokens(),
          client.getSelfLogStat(),
        ]);
        setStatus(nextStatus);
        setUser(nextUser);
        setTokens(nextTokens);
        setLogStat(nextStat);
        // Merge into whatever is stored now: a refresh triggered by one of the
        // requests above may have rotated the tokens, and this snapshot is stale.
        const stored = await loadSessionById(activeAccountId);
        if (stored) {
          await storeSession({ ...stored, user: nextUser });
        }
      } catch (loadError) {
        if (loadError instanceof SessionExpiredError) {
          const [nextSession, savedAccounts] = await Promise.all([
            loadSession(),
            listAccounts(),
          ]);
          setSession(nextSession);
          setAccounts(savedAccounts);
          setStatus(null);
          setUser(null);
          setLogStat(null);
          setTokens([]);
          setError('登录状态已失效，请重新登录');
          return;
        }
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (session) {
      void loadDashboard(session);
    }
  }, [session, loadDashboard]);

  const handleRefresh = useCallback(() => {
    if (!session || loading) {
      return;
    }
    void loadDashboard(session);
  }, [session, loading, loadDashboard]);

  const handleLogout = useCallback(() => {
    void (async () => {
      if (session) {
        await new NewApiClient(session.baseUrl, accountIdOf(session)).logout();
      }
      const [nextSession, savedAccounts] = await Promise.all([loadSession(), listAccounts()]);
      setSession(nextSession);
      setAccounts(savedAccounts);
      setStatus(null);
      setUser(null);
      setLogStat(null);
      setTokens([]);
      setError('');
    })();
  }, [session]);

  const handleLoggedIn = useCallback(() => {
    void (async () => {
      const [stored, savedAccounts] = await Promise.all([loadSession(), listAccounts()]);
      setAddingAccount(false);
      setSession(stored);
      setAccounts(savedAccounts);
    })();
  }, []);

  const handleSwitchAccount = useCallback((accountId: string) => {
    void (async () => {
      await setActiveAccount(accountId);
      const [stored, savedAccounts] = await Promise.all([loadSession(), listAccounts()]);
      setSession(stored);
      setAccounts(savedAccounts);
      setStatus(null);
      setUser(null);
      setLogStat(null);
      setTokens([]);
      setError('');
    })();
  }, []);

  const handleRemoveAccount = useCallback((accountId: string) => {
    void (async () => {
      const target = (await listAccounts()).find((item) => accountIdOf(item) === accountId);
      if (target) {
        await new NewApiClient(target.baseUrl, accountId).logout();
      } else {
        await removeAccount(accountId);
      }
      const [stored, savedAccounts] = await Promise.all([loadSession(), listAccounts()]);
      setSession(stored);
      setAccounts(savedAccounts);
      setStatus(null);
      setUser(null);
      setLogStat(null);
      setTokens([]);
      setError('');
    })();
  }, []);

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
      tokens={tokens}
      accounts={accounts}
      activeAccountId={accountIdOf(session)}
      loading={loading}
      error={error}
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
