import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { listen } from '@tauri-apps/api/event';
import { Button, Dropdown, Space, Spin, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { CheckOutlined, CloseOutlined, ReloadOutlined, UserOutlined } from '@ant-design/icons';
import {
  NewApiClient,
  RateLimitError,
  accountIdOf,
  formatQuota,
  hostOf,
  listAccounts,
  loadSession,
  setActiveAccount,
} from '../api';
import type { StoredSession } from '../api';
import type { NewApiStatus, SelfUser } from '../types';
import { useSleepWatchdog } from '../hooks/useSleepWatchdog';
import FittedText from './FittedText';

const REFRESH_INTERVAL_MS = 30000;

export default function FloatingBalance() {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession());
  const [accounts, setAccounts] = useState<StoredSession[]>(() => listAccounts());
  const [status, setStatus] = useState<NewApiStatus | null>(null);
  const [user, setUser] = useState<SelfUser | null>(session?.user ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const refreshingRef = useRef(false);
  const refreshQueuedRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen('accounts-changed', () => {
      if (disposed) {
        return;
      }
      setAccounts(listAccounts());
      setSession(loadSession());
      setUser(loadSession()?.user ?? null);
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const load = useCallback(async () => {
    if (!session) {
      return;
    }
    if (refreshingRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshingRef.current = true;
    setLoading(true);
    setError('');
    try {
      const client = new NewApiClient(session.baseUrl, accountIdOf(session));
      const [nextStatus, nextUser] = await Promise.all([client.getStatus(), client.getSelf()]);
      setStatus(nextStatus);
      setUser(nextUser);
    } catch (loadError) {
      if (loadError instanceof RateLimitError) {
        // 浮动窗很小，限流时只留一行提示，数字继续显示上一次的结果
        setError('限流（429），稍后重试');
        return;
      }
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      refreshingRef.current = false;
      const stillLoggedIn = Boolean(loadSession());
      if (refreshQueuedRef.current && stillLoggedIn) {
        refreshQueuedRef.current = false;
        void load();
      } else {
        refreshQueuedRef.current = false;
        setLoading(false);
      }
    }
  }, [session]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  useSleepWatchdog({
    onResume: () => {
      void load();
    },
  });

  const handleClose = useCallback(async () => {
    const current = getCurrentWebviewWindow();
    try {
      await current.close();
    } catch {
      // 某些平台上 close 可能被拒绝，退一步隐藏窗口，保证按钮一定有反应
      try {
        await current.hide();
      } catch {
        // 隐藏也失败时不再抛出，窗口仍可通过任务栏恢复
      }
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        void handleClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleClose]);

  const accountItems: MenuProps['items'] = accounts.map((account) => {
    const id = accountIdOf(account);
    const isActive = Boolean(session && accountIdOf(session) === id);
    return {
      key: id,
      label: (
        <div className="floating-account-item">
          <span>{account.user?.display_name || account.user?.username || hostOf(account.baseUrl)}</span>
          <span className="floating-account-host">{hostOf(account.baseUrl)}</span>
        </div>
      ),
      icon: isActive ? <CheckOutlined /> : null,
    };
  });

  function handleAccountSwitch(accountId: string) {
    setActiveAccount(accountId);
    setAccounts(listAccounts());
    setSession(loadSession());
    setUser(loadSession()?.user ?? null);
  }

  if (!session) {
    return (
      <div className="floating-root" data-tauri-drag-region>
        <Typography.Text type="secondary">未登录</Typography.Text>
        <Button size="small" type="text" onClick={() => void handleClose()}>
          关闭
        </Button>
      </div>
    );
  }

  return (
    <div className="floating-root" data-tauri-drag-region>
      <div className="floating-head">
        <Dropdown
          menu={{ items: accountItems, onClick: ({ key }) => handleAccountSwitch(key) }}
          trigger={['click']}
        >
          <Button size="small" type="text" icon={<UserOutlined />} className="floating-account-button">
            <span className="floating-title">
              {user?.display_name || user?.username || '余额'}
            </span>
          </Button>
        </Dropdown>
        <Space size={4}>
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined />}
            onClick={() => void load()}
            loading={loading}
          />
          <Button
            size="small"
            type="text"
            icon={<CloseOutlined />}
            onClick={() => void handleClose()}
          />
        </Space>
      </div>
      {error ? (
        <Typography.Text type="danger" className="floating-error">
          {error}
        </Typography.Text>
      ) : null}
      <div className="floating-metrics">
        <div className="floating-value">
          {loading && !user ? (
            <Spin size="small" />
          ) : (
            <FittedText text={formatQuota(user?.quota ?? 0, status)} />
          )}
        </div>
        <Typography.Text type="secondary" className="floating-sub">
          已用 {formatQuota(user?.used_quota ?? 0, status)}
        </Typography.Text>
      </div>
    </div>
  );
}
