import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../theme';

export type StatCardProps = {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'primary';
  flex?: boolean;
};

export default function StatCard({ label, value, hint, tone = 'default', flex }: StatCardProps) {
  return (
    <View style={[styles.card, flex ? styles.cardFlex : null, tone === 'primary' ? styles.cardPrimary : null]}>
      <Text style={[styles.label, tone === 'primary' ? styles.labelPrimary : null]} numberOfLines={1}>
        {label}
      </Text>
      <Text
        style={[styles.value, tone === 'primary' ? styles.valuePrimary : null]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>
      {hint ? (
        <Text style={[styles.hint, tone === 'primary' ? styles.labelPrimary : null]} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  cardFlex: {
    flex: 1,
  },
  cardPrimary: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  label: {
    fontSize: 12,
    color: colors.textSecondary,
  },
  labelPrimary: {
    color: 'rgba(255, 255, 255, 0.78)',
  },
  value: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
  },
  valuePrimary: {
    color: '#ffffff',
    fontSize: 24,
  },
  hint: {
    fontSize: 11,
    color: colors.textSecondary,
  },
});
