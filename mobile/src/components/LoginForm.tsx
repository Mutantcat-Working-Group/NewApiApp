import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { NewApiClient } from '../api';
import { colors, radius, spacing } from '../theme';

export type LoginFormProps = {
  onLoggedIn: () => void;
};

export default function LoginForm({ onLoggedIn }: LoginFormProps) {
  const [baseUrl, setBaseUrl] = useState('https://');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
      await client.passwordLogin(username.trim(), password);
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
          <View style={styles.logo}>
            <Text style={styles.logoText}>N</Text>
          </View>
          <Text style={styles.title}>NewApiApp</Text>
          <Text style={styles.subtitle}>new-api 中转站移动客户端</Text>
        </View>

        <View style={styles.card}>
          {error ? (
            <View style={styles.alert}>
              <Text style={styles.alertText}>{error}</Text>
            </View>
          ) : null}

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
  logo: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  logoText: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '700',
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
  footer: {
    textAlign: 'center',
    fontSize: 12,
    color: colors.textSecondary,
  },
});
