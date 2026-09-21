import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { LogoutOutlined, PushpinOutlined, ReloadOutlined } from '@ant-design/icons';
import { formatQuota } from '../api';
import type { LogStat, NewApiStatus, SelfUser, TokenItem } from '../types';

type DashboardProps = {
  session: { baseUrl: string };
  status: NewApiStatus | null;
  user: SelfUser | null;
  logStat: LogStat | null;
  tokens: TokenItem[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onLogout: () => void;
  onOpenFloatingWindow: () => void;
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
  return new Date(timestamp * 1000).toLocaleString('zh-CN', { hour12: false });
}

export default function Dashboard({
  session,
  status,
  user,
  logStat,
  tokens,
  loading,
  error,
  onRefresh,
  onLogout,
  onOpenFloatingWindow,
}: DashboardProps) {
  const columns: TableColumnsType<TokenItem> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: '密钥',
      dataIndex: 'key',
      key: 'key',
      render: (value: string) => <Typography.Text code>{maskKey(value)}</Typography.Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 88,
      render: (value: number) =>
        value === 1 ? <Tag color="green">启用</Tag> : <Tag color="red">禁用</Tag>,
    },
    {
      title: '剩余额度',
      dataIndex: 'remain_quota',
      key: 'remain_quota',
      render: (value: number, record) =>
        record.unlimited_quota ? '无限' : formatQuota(value, status),
    },
    {
      title: '已用额度',
      dataIndex: 'used_quota',
      key: 'used_quota',
      render: (value: number) => formatQuota(value ?? 0, status),
    },
    {
      title: '过期时间',
      dataIndex: 'expired_time',
      key: 'expired_time',
      render: (value: number) => formatTimestamp(value),
    },
  ];

  return (
    <div className="app-shell">
      <Card className="app-header" bordered={false}>
        <div className="app-header-main">
          <div className="app-title-group">
            <Typography.Title level={4} style={{ margin: 0 }}>
              NewApiApp
            </Typography.Title>
            <Space size={8} wrap>
              <Tag color="blue">{status?.system_name || 'new-api'}</Tag>
              <Typography.Text type="secondary">{status?.version || '-'}</Typography.Text>
            </Space>
          </div>
          <Space wrap>
            <Button icon={<ReloadOutlined />} onClick={onRefresh} loading={loading}>
              刷新
            </Button>
            <Button
              type="primary"
              icon={<PushpinOutlined />}
              onClick={onOpenFloatingWindow}
            >
              悬浮余额窗
            </Button>
            <Button danger icon={<LogoutOutlined />} onClick={onLogout}>
              退出登录
            </Button>
          </Space>
        </div>
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2, lg: 3 }}
          style={{ marginTop: 12, marginBottom: 0 }}
        >
          <Descriptions.Item label="当前站点">
            <Typography.Link href={session.baseUrl} target="_blank" rel="noreferrer">
              {session.baseUrl}
            </Typography.Link>
          </Descriptions.Item>
          <Descriptions.Item label="登录账号">
            {user?.display_name || user?.username || '-'}
          </Descriptions.Item>
          <Descriptions.Item label="用户组">{user?.group || '-'}</Descriptions.Item>
        </Descriptions>
      </Card>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card className="stat-card" bordered={false} hoverable>
            <Statistic title="剩余额度" value={formatQuota(user?.quota ?? 0, status)} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="stat-card" bordered={false} hoverable>
            <Statistic title="已用额度" value={formatQuota(user?.used_quota ?? 0, status)} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="stat-card" bordered={false} hoverable>
            <Statistic title="请求次数" value={user?.request_count ?? 0} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="stat-card" bordered={false} hoverable>
            <Statistic title="令牌数量" value={tokens.length} />
          </Card>
        </Col>
      </Row>

      <Card title="近 24 小时" className="section-card" bordered={false} hoverable>
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={8}>
            <Statistic title="消耗额度" value={formatQuota(logStat?.quota ?? 0, status)} />
          </Col>
          <Col xs={24} sm={8}>
            <Statistic title="RPM" value={logStat?.rpm ?? 0} />
          </Col>
          <Col xs={24} sm={8}>
            <Statistic title="TPM" value={logStat?.tpm ?? 0} />
          </Col>
        </Row>
      </Card>

      <Card title="API 令牌" className="section-card" bordered={false} hoverable>
        {tokens.length === 0 ? (
          <Empty description="暂无令牌" />
        ) : (
          <Table
            rowKey="id"
            columns={columns}
            dataSource={tokens}
            pagination={false}
            size="small"
            scroll={{ y: 360 }}
          />
        )}
      </Card>
    </div>
  );
}
