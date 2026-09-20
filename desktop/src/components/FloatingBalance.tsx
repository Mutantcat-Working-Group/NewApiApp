import { useCallback, useEffect, useState } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Button, Space, Spin, Typography } from 'antd';
import { CloseOutlined, ReloadOutlined } from '@ant-design/icons';
import { NewApiClient, formatQuota, loadSession } from '../api';
import type { StoredSession } from '../api';
import type { NewApiStatus, SelfUser } from '../types';

const REFRESH_INTERVAL_MS = 30000;

export default function FloatingBalance() {
  const [session] = useState<StoredSession | null>(() => loadSession());
  const [status, setStatus] = useState<NewApiStatus | null>(null);
  const [user, setUser] = useState<SelfUser | null>(session?.user ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!session) {
      return;
    }
    setLoading(true);
    setError('');
    try {
      const client = new NewApiClient(session.baseUrl);
      const [nextStatus, nextUser] = await Promise.all([client.getStatus(), client.getSelf()]);
      setStatus(nextStatus);
      setUser(nextUser);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function handleClose() {
    await getCurrentWebviewWindow().close();
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
        <Typography.Text strong className="floating-title">
          余额
        </Typography.Text>
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
      ) : (
        <div className="floating-metrics">
          <div className="floating-value">
            {loading && !user ? <Spin size="small" /> : formatQuota(user?.quota ?? 0, status)}
          </div>
          <Typography.Text type="secondary" className="floating-sub">
            已用 {formatQuota(user?.used_quota ?? 0, status)}
          </Typography.Text>
        </div>
      )}
    </div>
  );
}
