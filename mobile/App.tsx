/**
 * NewApiApp - new-api relay panel client (mobile)
 */

import { useCallback, useEffect, useState } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import DashboardScreen from './src/components/DashboardScreen';
import LoginForm from './src/components/LoginForm';
import { NewApiClient, loadSession, saveSession } from './src/api';
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
      const stored = await loadSession();
      if (!active) {
        return;
      }
      setSession(stored);
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
        const client = new NewApiClient(activeSession.baseUrl);
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
        await saveSession({ ...activeSession, user: nextUser });
      } catch (loadError) {
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
      await saveSession(null);
      setSession(null);
      setStatus(null);
      setUser(null);
      setLogStat(null);
      setTokens([]);
      setError('');
    })();
  }, []);

  const handleLoggedIn = useCallback(() => {
    void (async () => {
      const stored = await loadSession();
      setSession(stored);
    })();
  }, []);

  if (booting) {
    return <View style={styles.boot} />;
  }

  if (!session) {
    return <LoginForm onLoggedIn={handleLoggedIn} />;
  }

  return (
    <DashboardScreen
      session={session}
      status={status}
      user={user}
      logStat={logStat}
      tokens={tokens}
      loading={loading}
      error={error}
      onRefresh={handleRefresh}
      onLogout={handleLogout}
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
