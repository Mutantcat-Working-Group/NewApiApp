import { summarizeUsage } from '../src/api';
import type { QuotaDateItem } from '../src/types';

// api.ts 会引入 AsyncStorage，node 环境里没有实现；本用例只用纯函数。
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
  getAllKeys: jest.fn(() => Promise.resolve([])),
}));

function row(created_at: number, token_used: number, count: number): QuotaDateItem {
  return {
    id: 0,
    user_id: 1,
    model_name: 'gpt-4o',
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

test('24 小时窗口内的行相加', () => {
  const summary = summarizeUsage(
    [row(NOW - 60, 1200, 3), row(NOW - 3600, 800, 2), row(DAY_AGO + 10, 500, 1)],
    DAY_AGO,
  );
  expect(summary.tokenUsed).toBe(2500);
  expect(summary.count).toBe(6);
});

test('窗口之外的行不计入', () => {
  const summary = summarizeUsage([row(DAY_AGO - 1, 9999, 99), row(NOW, 10, 1)], DAY_AGO);
  expect(summary.tokenUsed).toBe(10);
  expect(summary.count).toBe(1);
});

test('空列表得到零值', () => {
  expect(summarizeUsage([], DAY_AGO)).toEqual({ tokenUsed: 0, count: 0 });
});
