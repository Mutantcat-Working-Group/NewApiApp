import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatQuota } from '../api';
import type { StoredSession } from '../api';
import type { LogStat, NewApiStatus, SelfUser, TokenItem } from '../types';
import StatCard from './StatCard';
import { colors, radius, spacing } from '../theme';

export type DashboardScreenProps = {
  session: StoredSession;
  status: NewApiStatus | null;
  user: SelfUser | null;
  logStat: LogStat | null;
  tokens: TokenItem[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onLogout: () => void;
};

function maskKey(key: string): string {
  if (key.length <= 12) {
    return key;
  }
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function formatTimestamp(timestamp: number): string {
  if (!timestamp) {
    return '永久';
  }
  const date = new Date(timestamp * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export default function DashboardScreen({
  session,
  status,
  user,
  logStat,
  tokens,
  loading,
  error,
  onRefresh,
  onLogout,
}: DashboardScreenProps) {
  const insets = useSafeAreaInsets();
  const remaining = formatQuota(user?.quota ?? 0, status);
  const used = formatQuota(user?.used_quota ?? 0, status);
  const consumed = formatQuota(logStat?.quota ?? 0, status);

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xl },
      ]}
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor={colors.primary} />
      }
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.appName}>NewApiApp</Text>
          <Text style={styles.siteName} numberOfLines={1}>
            {status?.system_name || 'new-api'} · v{status?.version || '-'}
          </Text>
        </View>
        <Text style={styles.logout} onPress={onLogout}>
          退出
        </Text>
      </View>

      <Text style={styles.siteUrl} numberOfLines={1}>
        {session.baseUrl}
      </Text>

      {error ? (
        <View style={styles.alert}>
          <Text style={styles.alertText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>剩余额度</Text>
        <Text style={styles.balanceValue} numberOfLines={1} adjustsFontSizeToFit>
          {remaining}
        </Text>
        <Text style={styles.balanceHint} numberOfLines={1}>
          {user?.display_name || user?.username || '未登录'} · {user?.group || '默认分组'}
        </Text>
      </View>

      <View style={styles.grid}>
        <StatCard label="已用额度" value={used} />
        <StatCard label="请求次数" value={String(user?.request_count ?? 0)} />
      </View>
      <View style={styles.grid}>
        <StatCard label="近 24 小时消耗" value={consumed} />
        <StatCard label="令牌数量" value={String(tokens.length)} />
      </View>
      <View style={styles.grid}>
        <StatCard label="RPM" value={String(logStat?.rpm ?? 0)} hint="近 24 小时" />
        <StatCard label="TPM" value={String(logStat?.tpm ?? 0)} hint="近 24 小时" />
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>API 令牌</Text>
        <Text style={styles.sectionCount}>{tokens.length}</Text>
      </View>

      {tokens.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>暂无令牌</Text>
        </View>
      ) : (
        <View style={styles.tokenList}>
          {tokens.map((token) => (
            <View key={token.id} style={styles.tokenRow}>
              <View style={styles.tokenMain}>
                <View style={styles.tokenTitleRow}>
                  <Text style={styles.tokenName} numberOfLines={1}>
                    {token.name || `令牌 #${token.id}`}
                  </Text>
                  <View
                    style={[
                      styles.badge,
                      token.status === 1 ? styles.badgeOn : styles.badgeOff,
                    ]}
                  >
                    <Text
                      style={[
                        styles.badgeText,
                        token.status === 1 ? styles.badgeTextOn : styles.badgeTextOff,
                      ]}
                    >
                      {token.status === 1 ? '启用' : '禁用'}
                    </Text>
                  </View>
                </View>
                <Text style={styles.tokenKey} numberOfLines={1}>
                  {maskKey(token.key)}
                </Text>
                <Text style={styles.tokenMeta} numberOfLines={1}>
                  剩余 {token.unlimited_quota ? '无限' : formatQuota(token.remain_quota, status)} ·{' '}
                  {formatTimestamp(token.expired_time)}过期
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  headerText: {
    flexShrink: 1,
  },
  appName: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
  },
  siteName: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  logout: {
    fontSize: 14,
    color: colors.danger,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  siteUrl: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: -spacing.sm,
  },
  alert: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.sm,
    padding: spacing.md,
  },
  alertText: {
    color: colors.danger,
    fontSize: 13,
    lineHeight: 18,
  },
  balanceCard: {
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  balanceLabel: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.8)',
  },
  balanceValue: {
    fontSize: 34,
    fontWeight: '700',
    color: '#ffffff',
  },
  balanceHint: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.8)',
  },
  grid: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  sectionCount: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  empty: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: spacing.xl,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  tokenList: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  tokenRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  tokenMain: {
    gap: 3,
  },
  tokenTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  tokenName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  badge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeOn: {
    backgroundColor: colors.successSoft,
  },
  badgeOff: {
    backgroundColor: colors.dangerSoft,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '500',
  },
  badgeTextOn: {
    color: colors.success,
  },
  badgeTextOff: {
    color: colors.danger,
  },
  tokenKey: {
    fontSize: 12,
    color: colors.textSecondary,
    fontFamily: 'Menlo',
  },
  tokenMeta: {
    fontSize: 12,
    color: colors.textSecondary,
  },
});
