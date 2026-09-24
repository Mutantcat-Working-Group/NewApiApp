import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Input,
  message,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  CheckCircleOutlined,
  GiftOutlined,
  LinkOutlined,
  LogoutOutlined,
  PushpinOutlined,
  ReloadOutlined,
  RocketOutlined,
} from '@ant-design/icons';
import { NewApiClient, formatQuota } from '../api';
import type {
  CheckinStatus,
  GroupInfo,
  LogItem,
  NewApiStatus,
  QuotaDateItem,
  SelfUser,
  SubscriptionPlan,
  SubscriptionSelf,
  TokenItem,
  TopUpInfo,
  TopUpItem,
} from '../types';
import TokenManager from './TokenManager';

type DashboardProps = {
  session: { baseUrl: string };
  status: NewApiStatus | null;
  user: SelfUser | null;
  logStat: { quota: number; rpm: number; tpm: number } | null;
  tokens: TokenItem[];
  notice: string;
  groups: Record<string, GroupInfo>;
  models: string[];
  quotaDates: QuotaDateItem[];
  usageLogs: LogItem[];
  topUpInfo: TopUpInfo | null;
  topUps: TopUpItem[];
  checkin: CheckinStatus | null;
  subscriptionPlans: SubscriptionPlan[];
  subscriptionSelf: SubscriptionSelf | null;
  affCode: string;
  loading: boolean;
  loadingExtras: boolean;
  error: string;
  onRefresh: () => void;
  onLogout: () => void;
  onOpenFloatingWindow: () => void;
};

const LOG_TYPE_LABELS: Record<number, string> = {
  1: '充值',
  2: '消耗',
  3: '管理',
  4: '系统',
  5: '错误',
  6: '退款',
  7: '登录',
};

const LOG_TYPE_COLORS: Record<number, string> = {
  1: 'green',
  2: 'blue',
  3: 'purple',
  4: 'cyan',
  5: 'red',
  6: 'orange',
  7: 'geekblue',
};

function formatTimestamp(timestamp: number): string {
  if (!timestamp) {
    return '永久';
  }
  return new Date(timestamp * 1000).toLocaleString('zh-CN', { hour12: false });
}

function formatDuration(milliseconds: number): string {
  if (!milliseconds) {
    return '-';
  }
  if (milliseconds < 1000) {
    return `${milliseconds} ms`;
  }
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

type DayUsage = {
  day: number;
  quota: number;
  count: number;
  tokenUsed: number;
  models: string[];
};

type DayUsageAccumulator = {
  day: number;
  quota: number;
  count: number;
  tokenUsed: number;
  models: Set<string>;
};

function groupQuotaByDay(items: QuotaDateItem[]): DayUsage[] {
  const map = new Map<number, DayUsageAccumulator>();
  for (const item of items) {
    const day = Math.floor(item.created_at / 86400) * 86400;
    const entry = map.get(day) ?? {
      day,
      quota: 0,
      count: 0,
      tokenUsed: 0,
      models: new Set<string>(),
    };
    entry.quota += item.quota ?? 0;
    entry.count += item.count ?? 0;
    entry.tokenUsed += item.token_used ?? 0;
    if (item.model_name) {
      entry.models.add(item.model_name);
    }
    map.set(day, entry);
  }
  return [...map.values()]
    .map((entry) => ({ ...entry, models: [...entry.models] }))
    .sort((a, b) => b.day - a.day)
    .slice(0, 14);
}

export default function Dashboard({
  session,
  status,
  user,
  logStat,
  tokens,
  notice,
  groups,
  models,
  quotaDates,
  usageLogs,
  topUpInfo,
  topUps,
  checkin,
  subscriptionPlans,
  subscriptionSelf,
  affCode,
  loading,
  loadingExtras,
  error,
  onRefresh,
  onLogout,
  onOpenFloatingWindow,
}: DashboardProps) {
  const client = useMemo(() => new NewApiClient(session.baseUrl), [session.baseUrl]);
  const [redeemKey, setRedeemKey] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [checkinBusy, setCheckinBusy] = useState(false);
  const dayUsage = groupQuotaByDay(quotaDates);
  const maxDayQuota = Math.max(0, ...dayUsage.map((entry) => entry.quota));
  const todayCheckedIn = checkin?.stats?.checked_in_today ?? false;
  const activeSubscriptions = subscriptionSelf?.subscriptions ?? [];

  async function handleRedeem() {
    const key = redeemKey.trim();
    if (!key) {
      message.warning('请输入兑换码');
      return;
    }
    setRedeeming(true);
    try {
      const quota = await client.redeemTopUpKey(key);
      message.success(`兑换成功，已入账 ${formatQuota(quota, status)}`);
      setRedeemKey('');
      onRefresh();
    } catch (redeemError) {
      message.error(redeemError instanceof Error ? redeemError.message : String(redeemError));
    } finally {
      setRedeeming(false);
    }
  }

  async function handleCheckin() {
    setCheckinBusy(true);
    try {
      const result = await client.doCheckin();
      message.success(`签到成功，获得 ${formatQuota(result.quota_awarded, status)}`);
      onRefresh();
    } catch (checkinError) {
      message.error(checkinError instanceof Error ? checkinError.message : String(checkinError));
    } finally {
      setCheckinBusy(false);
    }
  }

  const logColumns: TableColumnsType<LogItem> = [
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (value: number) => formatTimestamp(value),
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 80,
      render: (value: number) => (
        <Tag color={LOG_TYPE_COLORS[value] ?? 'default'}>{LOG_TYPE_LABELS[value] ?? value}</Tag>
      ),
    },
    {
      title: '模型',
      dataIndex: 'model_name',
      key: 'model_name',
      width: 180,
      ellipsis: true,
      render: (value: string) => value || '-',
    },
    {
      title: '令牌',
      dataIndex: 'token_name',
      key: 'token_name',
      width: 130,
      ellipsis: true,
      render: (value: string) => value || '-',
    },
    {
      title: '提示词',
      dataIndex: 'prompt_tokens',
      key: 'prompt_tokens',
      width: 90,
      render: (value: number) => value ?? 0,
    },
    {
      title: '补全',
      dataIndex: 'completion_tokens',
      key: 'completion_tokens',
      width: 90,
      render: (value: number) => value ?? 0,
    },
    {
      title: '额度',
      dataIndex: 'quota',
      key: 'quota',
      width: 120,
      render: (value: number) => formatQuota(value ?? 0, status),
    },
    {
      title: '耗时',
      dataIndex: 'use_time',
      key: 'use_time',
      width: 90,
      render: (value: number) => formatDuration(value ?? 0),
    },
    {
      title: '请求 ID',
      dataIndex: 'request_id',
      key: 'request_id',
      ellipsis: true,
      render: (value: string) => value || '-',
    },
  ];

  return (
    <div className="app-shell">
      <Card className="app-header" bordered={false}>
        <div className="app-header-main">
          <div className="app-title-group">
            <img src="/icon.png" alt="NewApiApp" className="app-logo" />
            <Typography.Title level={4} style={{ margin: 0 }}>
              NewApiApp
            </Typography.Title>
            <Space size={8} wrap>
              <Tag color="blue">{status?.system_name || 'new-api'}</Tag>
              <Typography.Text type="secondary">{status?.version || '-'}</Typography.Text>
            </Space>
          </div>
          <Space wrap>
            <Button icon={<ReloadOutlined />} onClick={onRefresh} loading={loading || loadingExtras}>
              刷新
            </Button>
            <Button type="primary" icon={<PushpinOutlined />} onClick={onOpenFloatingWindow}>
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
          {/* 发行方信息：由异猫工作群（mutantcat.org）发行。 */}
          <Descriptions.Item label="发行方">
            异猫工作群（mutantcat.org）{' '}
            <Typography.Link href="https://github.com/Mutantcat-Working-Group" target="_blank" rel="noreferrer">
              github.com/Mutantcat-Working-Group
            </Typography.Link>
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 0 }} /> : null}
      {notice ? (
        <Alert
          type="info"
          showIcon
          message="站点公告"
          description={notice}
          style={{ marginBottom: 0 }}
        />
      ) : null}

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

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <Card title="近 24 小时" className="section-card" bordered={false} hoverable>
            <Row gutter={[16, 16]}>
              <Col xs={24} sm={8} lg={24}>
                <Statistic title="消耗额度" value={formatQuota(logStat?.quota ?? 0, status)} />
              </Col>
              <Col xs={24} sm={8} lg={24}>
                <Statistic title="RPM" value={logStat?.rpm ?? 0} />
              </Col>
              <Col xs={24} sm={8} lg={24}>
                <Statistic title="TPM" value={logStat?.tpm ?? 0} />
              </Col>
            </Row>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card
            title="每日签到"
            className="section-card"
            bordered={false}
            hoverable
            extra={
              <Button
                type={todayCheckedIn ? 'default' : 'primary'}
                icon={<GiftOutlined />}
                loading={checkinBusy}
                disabled={todayCheckedIn || !checkin?.enabled}
                onClick={() => void handleCheckin()}
              >
                {todayCheckedIn ? '今日已签到' : '签到'}
              </Button>
            }
          >
            {!checkin ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="站点未启用签到" />
            ) : (
              <Row gutter={[16, 16]}>
                <Col span={8}>
                  <Statistic title="累计签到" value={checkin.stats?.total_checkins ?? 0} />
                </Col>
                <Col span={8}>
                  <Statistic
                    title="累计奖励"
                    value={formatQuota(checkin.stats?.total_quota ?? 0, status)}
                  />
                </Col>
                <Col span={8}>
                  <Statistic title="本月签到" value={checkin.stats?.checkin_count ?? 0} />
                </Col>
              </Row>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title="邀请推广" className="section-card" bordered={false} hoverable>
            {affCode ? (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Text>邀请码</Typography.Text>
                <Typography.Title level={3} style={{ margin: 0 }}>
                  {affCode}
                </Typography.Title>
                <Typography.Text type="secondary">
                  累计邀请 {user?.aff_count ?? 0} 人 · 奖励额度{' '}
                  {formatQuota(user?.aff_quota ?? 0, status)}
                </Typography.Text>
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无邀请信息" />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} className="usage-row">
        <Col xs={24} lg={10}>
          <Card title="兑换码充值" className="section-card" bordered={false} hoverable>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                value={redeemKey}
                onChange={(event) => setRedeemKey(event.target.value)}
                placeholder="输入兑换码"
                onPressEnter={() => void handleRedeem()}
                disabled={!topUpInfo?.enable_redemption}
              />
              <Button
                type="primary"
                icon={<RocketOutlined />}
                loading={redeeming}
                onClick={() => void handleRedeem()}
                disabled={!topUpInfo?.enable_redemption}
              >
                兑换
              </Button>
            </Space.Compact>
            {!topUpInfo?.enable_redemption ? (
              <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
                站点未开启兑换码充值，或尚未确认支付合规协议。
              </Typography.Paragraph>
            ) : null}
            {topUps.length > 0 ? (
              <div className="compact-list">
                {topUps.slice(0, 5).map((topUp) => (
                  <div key={topUp.id} className="compact-list-row">
                    <span>
                      {formatTimestamp(topUp.create_time)} · {topUp.trade_no}
                    </span>
                    <Tag color={topUp.status === 'completed' ? 'green' : 'orange'}>
                      {topUp.status === 'completed' ? '完成' : topUp.status}
                    </Tag>
                    <span className="compact-list-value">+{formatQuota(topUp.amount, status)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
                暂无充值记录
              </Typography.Paragraph>
            )}
            {topUpInfo?.enable_online_topup && topUpInfo.topup_link ? (
              <Typography.Paragraph style={{ marginTop: 12, marginBottom: 0 }}>
                <Button
                  type="link"
                  icon={<LinkOutlined />}
                  href={topUpInfo.topup_link}
                  target="_blank"
                  rel="noreferrer"
                  style={{ padding: 0 }}
                >
                  前往网页充值
                </Button>
              </Typography.Paragraph>
            ) : null}
            {topUpInfo?.amount_options && topUpInfo.amount_options.length > 0 ? (
              <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                可用档位：{topUpInfo.amount_options.join(' / ')}
              </Typography.Paragraph>
            ) : null}
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title="近 14 天用量" className="section-card" bordered={false} hoverable>
            {dayUsage.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无用量数据" />
            ) : (
              <div className="day-usage-list">
                {dayUsage.map((entry) => (
                  <div key={entry.day} className="day-usage-row">
                    <div className="day-usage-meta">
                      <span className="day-usage-date">
                        {new Date(entry.day * 1000).toLocaleDateString('zh-CN', {
                          month: '2-digit',
                          day: '2-digit',
                        })}
                      </span>
                      <span className="day-usage-detail">
                        {entry.count} 次 · {entry.models.length} 个模型 ·{' '}
                        {entry.tokenUsed.toLocaleString()} tokens
                      </span>
                    </div>
                    <div className="day-usage-right">
                      <span className="day-usage-value">{formatQuota(entry.quota, status)}</span>
                      <Progress
                        percent={maxDayQuota ? Math.round((entry.quota / maxDayQuota) * 100) : 0}
                        size="small"
                        showInfo={false}
                        strokeColor="#2f6fed"
                        trailColor="#e8ebf1"
                        className="day-usage-bar"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      <Card title="可用模型" className="section-card" bordered={false} hoverable>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space size={[6, 6]} wrap>
            {models.length === 0 ? (
              <Typography.Text type="secondary">暂无模型信息</Typography.Text>
            ) : (
              models.map((modelName) => <Tag key={modelName}>{modelName}</Tag>)
            )}
          </Space>
          {Object.keys(groups).length > 0 ? (
            <div className="group-list">
              {Object.entries(groups).map(([group, info]) => (
                <span key={group} className="group-item">
                  <Tag color="blue">{group}</Tag>
                  <Typography.Text type="secondary">
                    {info.desc || ''} 倍率 {info.ratio}
                  </Typography.Text>
                </span>
              ))}
            </div>
          ) : null}
        </Space>
      </Card>

      <Card title="API 令牌" className="section-card" bordered={false} hoverable>
        <TokenManager
          session={session}
          tokens={tokens}
          status={status}
          groups={groups}
          defaultGroup={user?.group || 'default'}
          loading={loading}
          onChanged={onRefresh}
        />
      </Card>

      <Card title="使用记录" className="section-card" bordered={false} hoverable>
        {usageLogs.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无使用记录" />
        ) : (
          <Table
            rowKey="id"
            columns={logColumns}
            dataSource={usageLogs}
            pagination={false}
            size="small"
            scroll={{ x: 980, y: 360 }}
          />
        )}
      </Card>

      {subscriptionPlans.length > 0 || activeSubscriptions.length > 0 ? (
        <Card title="订阅套餐" className="section-card" bordered={false} hoverable>
          <Row gutter={[16, 16]}>
            {activeSubscriptions.map((subscription) => (
              <Col xs={24} md={12} lg={8} key={subscription.id}>
                <Card size="small" className="subscription-card" bordered>
                  <div className="subscription-head">
                    <Typography.Text strong>套餐 #{subscription.plan_id}</Typography.Text>
                    <Tag color={subscription.status === 'active' ? 'green' : 'default'}>
                      {subscription.status === 'active' ? '生效中' : subscription.status}
                    </Tag>
                  </div>
                  <Progress
                    percent={
                      subscription.amount_total
                        ? Math.min(
                            100,
                            Math.round((subscription.amount_used / subscription.amount_total) * 100),
                          )
                        : 0
                    }
                    size="small"
                    strokeColor="#2f6fed"
                  />
                  <Typography.Text type="secondary">
                    已用 {formatQuota(subscription.amount_used, status)} /{' '}
                    {formatQuota(subscription.amount_total, status)}
                  </Typography.Text>
                  <br />
                  <Typography.Text type="secondary">
                    到期 {formatTimestamp(subscription.end_time)}
                  </Typography.Text>
                </Card>
              </Col>
            ))}
            {subscriptionPlans.map((entry) => (
              <Col xs={24} md={12} lg={8} key={entry.plan.id}>
                <Card size="small" className="subscription-card" bordered>
                  <div className="subscription-head">
                    <Typography.Text strong>{entry.plan.title}</Typography.Text>
                    <Tag color="blue">
                      {entry.plan.currency} {entry.plan.price_amount}
                    </Tag>
                  </div>
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>
                    {entry.plan.subtitle ||
                      `${entry.plan.duration_value} ${entry.plan.duration_unit} · ${
                        entry.plan.total_amount
                          ? `${formatQuota(entry.plan.total_amount, status)} 额度`
                          : '额度不限'
                      }`}
                  </Typography.Paragraph>
                  {entry.plan.allow_balance_pay ? (
                    <Button size="small" icon={<CheckCircleOutlined />} disabled>
                      余额支付（网页端开通）
                    </Button>
                  ) : null}
                </Card>
              </Col>
            ))}
          </Row>
        </Card>
      ) : null}
    </div>
  );
}
