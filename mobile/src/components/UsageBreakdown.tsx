import { StyleSheet, Text, View } from 'react-native';
import DonutChart, { LineChart, type DonutSlice } from './Charts';
import { formatHour, formatNumber } from '../format';
import type { HourPoint, ModelShare } from '../usage';
import { topModelShares } from '../usage';
import { colors, radius, spacing } from '../theme';

const PALETTE = [
  '#2f6fed',
  '#7c5cff',
  '#0ea5a5',
  '#f59e0b',
  '#ef4d7a',
  '#8b95a7',
];

/** 同一模型固定用同一个颜色，避免刷新时颜色乱跳。 */
function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

export type UsageBreakdownProps = {
  models: ModelShare[];
  hours: HourPoint[];
  /** 站点没有返回用量数据时显示占位，不画空图。 */
  empty: boolean;
};

/** API 令牌上方的「调用分布」：近 24 小时的模型占比与逐小时 token 走势。 */
export default function UsageBreakdown({ models, hours, empty }: UsageBreakdownProps) {
  const shares = topModelShares(models);
  const slices: DonutSlice[] = shares.map((entry, index) => ({
    label: entry.model,
    value: entry.tokenUsed,
    color: colorFor(index),
  }));
  // 峰值标在图标题旁，省一次纵轴刻度。
  const peak = hours.reduce((best, entry) => (entry.tokenUsed > best.tokenUsed ? entry : best), {
    timestamp: 0,
    tokenUsed: 0,
    count: 0,
  });

  return (
    <View style={styles.card}>
      <Text style={styles.title}>调用分布</Text>
      <Text style={styles.subtitle}>近 24 小时</Text>

      {empty ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>站点未开放用量接口</Text>
        </View>
      ) : (
        <>
          <View style={styles.pieRow}>
            <DonutChart slices={slices} />
            <View style={styles.legend}>
              {shares.map((entry, index) => (
                <View key={entry.model} style={styles.legendRow}>
                  <View style={[styles.dot, { backgroundColor: colorFor(index) }]} />
                  <Text style={styles.legendLabel} numberOfLines={1}>
                    {entry.model}
                  </Text>
                  <Text style={styles.legendValue}>
                    {Math.round(entry.share * 100)}%
                  </Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.chartHead}>
            <Text style={styles.chartTitle}>逐小时 Token</Text>
            {peak.tokenUsed > 0 ? (
              <Text style={styles.chartPeak}>
                峰值 {formatNumber(peak.tokenUsed)} · {formatHour(peak.timestamp)}
              </Text>
            ) : null}
          </View>
          <LineChart points={hours.map((entry) => ({ label: formatHour(entry.timestamp), value: entry.tokenUsed }))} />
          <View style={styles.axis}>
            {[0, Math.floor(hours.length / 2), hours.length - 1].map((index) => (
              <Text key={`tick-${index}`} style={styles.axisTick} numberOfLines={1}>
                {formatHour(hours[index]?.timestamp ?? 0)}
              </Text>
            ))}
          </View>
          <Text style={styles.footnote}>
            合计 {formatNumber(hours.reduce((sum, entry) => sum + entry.tokenUsed, 0))} tokens ·{' '}
            {formatNumber(hours.reduce((sum, entry) => sum + entry.count, 0))} 次请求
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  subtitle: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: -spacing.xs,
  },
  empty: {
    paddingVertical: spacing.xl,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 13,
    color: colors.textSecondary,
  },
  pieRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  legend: {
    flex: 1,
    minWidth: 0,
    gap: 6,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: colors.text,
  },
  legendValue: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  chartHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  chartTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  chartPeak: {
    fontSize: 11,
    color: colors.textSecondary,
  },
  axis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: -spacing.xs,
  },
  axisTick: {
    fontSize: 9,
    color: colors.textSecondary,
  },
  footnote: {
    fontSize: 11,
    color: colors.textSecondary,
  },
});
