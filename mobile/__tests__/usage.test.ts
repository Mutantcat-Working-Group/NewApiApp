import { deriveUsage, summarizeUsage, topModelShares } from '../src/usage';
import { formatHour, formatNumber } from '../src/format';
import type { QuotaDateItem } from '../src/types';

function row(
  created_at: number,
  model_name: string,
  token_used: number,
  count: number,
): QuotaDateItem {
  return {
    id: 0,
    user_id: 1,
    model_name,
    created_at,
    use_group: 'default',
    token_id: 0,
    channel_id: 0,
    node_name: '',
    token_used,
    count,
    quota: 0,
  };
}

const NOW = 1_800_000_000;
const DAY_AGO = NOW - 24 * 60 * 60;
const HOUR_AGO = NOW - 60 * 60;

test('只统计窗口内的行', () => {
  const summary = summarizeUsage(
    [row(HOUR_AGO, 'gpt-4o', 1200, 3), row(DAY_AGO + 10, 'gpt-4o', 500, 1)],
    DAY_AGO,
    NOW,
  );
  expect(summary.tokenUsed).toBe(1700);
  expect(summary.count).toBe(4);
});

test('窗口之外和脏数据不计入', () => {
  const summary = summarizeUsage(
    [row(DAY_AGO - 1, 'gpt-4o', 9999, 99), row(NOW + 1, 'gpt-4o', 9999, 99), row(0, 'gpt-4o', 1, 1)],
    DAY_AGO,
    NOW,
  );
  expect(summary.tokenUsed).toBe(0);
  expect(summary.count).toBe(0);
});

test('deriveUsage 拆分近一小时与近 24 小时', () => {
  const derived = deriveUsage(
    [
      row(NOW - 30, 'gpt-4o', 1000, 2),
      row(HOUR_AGO - 10, 'gpt-4o', 700, 3),
      row(DAY_AGO + 100, 'claude', 300, 1),
    ],
    NOW,
  );
  expect(derived.hour).toEqual({ tokenUsed: 1000, count: 2 });
  expect(derived.total).toEqual({ tokenUsed: 2000, count: 6 });
});

test('模型分布按 token 降序并给出占比', () => {
  const derived = deriveUsage(
    [
      row(HOUR_AGO, 'claude', 300, 1),
      row(HOUR_AGO, 'gpt-4o', 700, 1),
      row(HOUR_AGO, '', 100, 1),
    ],
    NOW,
  );
  expect(derived.models.map((entry) => entry.model)).toEqual(['gpt-4o', 'claude', '未知模型']);
  expect(derived.models[0].share).toBeCloseTo(0.636, 2);
});

test('逐小时序列补齐空档', () => {
  const derived = deriveUsage([row(HOUR_AGO, 'gpt-4o', 10, 1)], NOW);
  expect(derived.hours).toHaveLength(25);
  // 最后一格是当前这一小时，数据落在前一格。
  expect(derived.hours[24].timestamp).toBe(NOW);
  expect(derived.hours[23]).toEqual({ timestamp: HOUR_AGO, tokenUsed: 10, count: 1 });
  expect(derived.hours[0].tokenUsed).toBe(0);
});

test('超过上限的模型合并成其它', () => {
  const derived = deriveUsage(
    [
      row(HOUR_AGO, 'a', 10, 1),
      row(HOUR_AGO, 'b', 20, 1),
      row(HOUR_AGO, 'c', 30, 1),
      row(HOUR_AGO, 'd', 40, 1),
      row(HOUR_AGO, 'e', 50, 1),
      row(HOUR_AGO, 'f', 60, 1),
      row(HOUR_AGO, 'g', 70, 1),
      row(HOUR_AGO, 'h', 80, 1),
    ],
    NOW,
  );
  const shares = topModelShares(derived.models, 6);
  expect(shares).toHaveLength(6);
  // 前 5 个保留（80/70/60/50/40），剩下 30+20+10 合成「其它」。
  expect(shares.map((entry) => entry.model)).toEqual(['h', 'g', 'f', 'e', 'd', '其它']);
  expect(shares[5]).toMatchObject({ model: '其它', tokenUsed: 60 });
});

test('formatNumber 在窄卡片上折成 k / M', () => {
  expect(formatNumber(999)).toBe('999');
  expect(formatNumber(12_345)).toBe('12.3k');
  expect(formatNumber(2_500_000)).toBe('2.50M');
  expect(formatNumber(Number.NaN)).toBe('-');
});

test('formatHour 只给整点小时', () => {
  const timestamp = new Date(2026, 10, 22, 9, 30).getTime() / 1000;
  expect(formatHour(timestamp)).toBe('09:00');
});
