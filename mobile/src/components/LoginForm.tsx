import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  LoginVerificationRequiredError,
  NewApiClient,
  accountIdOf,
  hostOf,
} from '../api';
import type { StoredSession } from '../api';
import type { LoginChallenge } from '../types';
import { colors, radius, spacing } from '../theme';

export type LoginFormProps = {
  onLoggedIn: () => void;
  /** Why the previous session ended, so the login screen can explain itself. */
  notice?: string;
  /** 本机已保存的账号，可一键切换回看板。 */
  accounts?: StoredSession[];
  activeAccountId?: string | null;
  onSwitchAccount?: (accountId: string) => void;
  /** 从看板进入“添加账号”时显示返回入口。 */
  onCancel?: () => void;
};

type PendingVerification = {
  client: NewApiClient;
  challenge: LoginChallenge;
  baseUrl: string;
  username: string;
};

export default function LoginForm({
  onLoggedIn,
  notice,
  accounts = [],
  activeAccountId = null,
  onSwitchAccount,
  onCancel,
}: LoginFormProps) {
  const [baseUrl, setBaseUrl] = useState('https://');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [verification, setVerification] = useState<PendingVerification | null>(null);
  const [verificationCode, setVerificationCode] = useState('');

  async function handleLogin() {
    if (loading) {
      return;
    }
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedBaseUrl || !username.trim() || !password) {
      setError('请填写完整的中转站地址、账号和密码');
      return;
    }
    if (!/^https?:\/\//i.test(trimmedBaseUrl)) {
      setError('中转站地址需以 http:// 或 https:// 开头');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const client = new NewApiClient(trimmedBaseUrl);
      try {
        await client.passwordLogin(username.trim(), password);
      } catch (loginError) {
        if (loginError instanceof LoginVerificationRequiredError) {
          setVerification({
            client,
            challenge: loginError.challenge,
            baseUrl: trimmedBaseUrl,
            username: username.trim(),
          });
          setVerificationCode('');
          setError('');
          return;
        }
        throw loginError;
      }
      onLoggedIn();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify() {
    if (loading || !verification) {
      return;
    }
    setLoading(true);
    setError('');
    try {
      await verification.client.verifyLogin(
        verification.challenge.flow_token,
        verificationCode,
      );
      onLoggedIn();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={styles.brand}>
          <Image source={require('../assets/icon.png')} style={styles.logo} resizeMode="contain" />
          <Text style={styles.title}>NewApiApp</Text>
          <Text style={styles.subtitle}>new-api 中转站移动客户端</Text>
        </View>

        {onCancel ? (
          <Pressable style={styles.backButton} onPress={onCancel} disabled={loading}>
            <Text style={styles.backButtonText}>← 返回看板</Text>
          </Pressable>
        ) : null}

        {accounts.length > 0 ? (
          <View style={styles.savedSection}>
            <Text style={styles.savedTitle}>已保存的账号</Text>
            {accounts.map((account) => {
              const id = accountIdOf(account);
              const isActive = id === activeAccountId;
              return (
                <View key={id} style={styles.savedRow}>
                  <View style={styles.savedMain}>
                    <View style={styles.savedNameRow}>
                      <Text style={styles.savedName} numberOfLines={1}>
                        {account.user?.display_name || account.user?.username || '未命名账号'}
                      </Text>
                      {isActive ? (
                        <Text style={styles.savedCurrent}>当前</Text>
                      ) : null}
                    </View>
                    <Text style={styles.savedHost} numberOfLines={1}>
                      {hostOf(account.baseUrl)} · {account.user?.username || '未知用户'}
                    </Text>
                  </View>
                  {isActive ? null : (
                    <Pressable
                      style={styles.savedSwitch}
                      onPress={() => onSwitchAccount?.(id)}
                      disabled={loading}
                    >
                      <Text style={styles.savedSwitchText}>切换</Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>
        ) : null}

        <View style={styles.card}>
          {error ? (
            <View style={styles.alert}>
              <Text style={styles.alertText}>{error}</Text>
            </View>
          ) : null}
          {notice ? (
            <View style={styles.alert}>
              <Text style={styles.alertText}>{notice}</Text>
            </View>
          ) : null}

          {verification ? (
            <>
              <Text style={styles.summaryText}>
                {verification.baseUrl} · {verification.username}
              </Text>
              <Text style={styles.label}>动态验证码</Text>
              <TextInput
                style={styles.input}
                value={verificationCode}
                onChangeText={setVerificationCode}
                placeholder="请输入 2FA 动态验证码"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="number-pad"
                returnKeyType="go"
                autoFocus
                onSubmitEditing={() => void handleVerify()}
              />
              <Pressable
                style={({ pressed }) => [
                  styles.button,
                  pressed ? styles.buttonPressed : null,
                  loading ? styles.buttonDisabled : null,
                ]}
                onPress={() => void handleVerify()}
                disabled={loading}
              >
                {loading ? <ActivityIndicator color="#ffffff" size="small" /> : null}
                <Text style={styles.buttonText}>{loading ? '验证中…' : '验证并登录'}</Text>
              </Pressable>
              <Pressable
                style={styles.linkButton}
                onPress={() => {
                  setVerification(null);
                  setVerificationCode('');
                }}
                disabled={loading}
              >
                <Text style={styles.linkText}>返回上一步</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.label}>中转站根地址</Text>
              <TextInput
                style={styles.input}
                value={baseUrl}
                onChangeText={setBaseUrl}
                placeholder="https://api.example.com"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="next"
              />

              <Text style={styles.label}>账号</Text>
              <TextInput
                style={styles.input}
                value={username}
                onChangeText={setUsername}
                placeholder="用户名"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
              />

              <Text style={styles.label}>密码</Text>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                placeholder="密码"
                placeholderTextColor={colors.textSecondary}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="go"
                onSubmitEditing={() => void handleLogin()}
              />

              <Pressable
                style={({ pressed }) => [
                  styles.button,
                  pressed ? styles.buttonPressed : null,
                  loading ? styles.buttonDisabled : null,
                ]}
                onPress={() => void handleLogin()}
                disabled={loading}
              >
                {loading ? <ActivityIndicator color="#ffffff" size="small" /> : null}
                <Text style={styles.buttonText}>{loading ? '登录中…' : '登录'}</Text>
              </Pressable>
            </>
          )}
        </View>

        <Text style={styles.footer}>登录信息仅保存在本机，不会上传到第三方。</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.xl,
  },
  brand: {
    alignItems: 'center',
    gap: spacing.xs,
  },
  backButton: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs,
  },
  backButtonText: {
    fontSize: 14,
    color: colors.primary,
    fontWeight: '500',
  },
  savedSection: {
    gap: spacing.sm,
  },
  savedTitle: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  savedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
  },
  savedMain: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  savedNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  savedName: {
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  savedCurrent: {
    fontSize: 11,
    color: colors.primary,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  savedHost: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  savedSwitch: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  savedSwitchText: {
    fontSize: 13,
    color: '#ffffff',
    fontWeight: '600',
  },
  logo: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: '#ffffff',
    marginBottom: spacing.sm,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
  },
  subtitle: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  alert: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  alertText: {
    color: colors.danger,
    fontSize: 13,
    lineHeight: 18,
  },
  summaryText: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.text,
    marginBottom: spacing.xs,
    marginTop: spacing.sm,
  },
  input: {
    height: 44,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
    fontSize: 15,
    color: colors.text,
  },
  button: {
    marginTop: spacing.xl,
    height: 46,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  linkButton: {
    marginTop: spacing.sm,
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  linkText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '500',
  },
  footer: {
    textAlign: 'center',
    fontSize: 12,
    color: colors.textSecondary,
  },
});
