/**
 * @format
 */

import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import { formatQuota } from '../src/api';
import type { NewApiStatus } from '../src/types';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: null,
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
}));

const status: NewApiStatus = {
  version: 'v0.8.0',
  system_name: 'new-api',
  logo: '',
  quota_per_unit: 500000,
  display_in_currency: true,
  quota_display_type: 'USD',
  custom_currency_symbol: '',
  custom_currency_exchange_rate: 1,
  usd_exchange_rate: 7.2,
  password_login_enabled: true,
  password_login_encryption_enabled: false,
  register_enabled: false,
};

test('renders the login form when no session is stored', async () => {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  const texts = tree!.root.findAllByType(Text).map((node) => node.props.children);
  expect(texts).toContain('NewApiApp');
  expect(texts).toContain('登录');
});

test('formats quota as USD', () => {
  expect(formatQuota(500000, status)).toBe('$1');
  expect(formatQuota(1000000, status)).toBe('$2');
});

test('formats quota as CNY when the site uses CNY display', () => {
  expect(formatQuota(500000, { ...status, quota_display_type: 'CNY' })).toBe('CNY 7.2');
});

test('returns the raw quota when currency display is disabled', () => {
  expect(formatQuota(500000, { ...status, display_in_currency: false })).toBe('500000');
});
