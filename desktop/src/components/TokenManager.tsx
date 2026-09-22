import { useMemo, useState } from 'react';
import {
  Button,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  EyeOutlined,
  PlusOutlined,
  StopOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import { NewApiClient, formatQuota } from '../api';
import type { GroupInfo, NewApiStatus, TokenItem, TokenPayload } from '../types';

type TokenManagerProps = {
  session: { baseUrl: string };
  tokens: TokenItem[];
  status: NewApiStatus | null;
  groups: Record<string, GroupInfo>;
  defaultGroup: string;
  loading: boolean;
  onChanged: () => void;
};

const DAY = 24 * 60 * 60;

function formatTimestamp(timestamp: number): string {
  if (!timestamp) {
    return '永久';
  }
  return new Date(timestamp * 1000).toLocaleString('zh-CN', { hour12: false });
}

function maskKey(key: string): string {
  if (key.length <= 12) {
    return key;
  }
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

async function copyText(text: string): Promise<void> {
  try {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
    return;
  } catch {
    // Fall back to the browser clipboard when running outside Tauri.
  }
  await navigator.clipboard.writeText(text);
}

export default function TokenManager({
  session,
  tokens,
  status,
  groups,
  defaultGroup,
  loading,
  onChanged,
}: TokenManagerProps) {
  const client = useMemo(() => new NewApiClient(session.baseUrl), [session.baseUrl]);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [keyLoadingId, setKeyLoadingId] = useState<number | null>(null);
  const [keyModal, setKeyModal] = useState<{ token: TokenItem; key: string } | null>(null);
  const [form] = Form.useForm();
  const groupOptions = Object.keys(groups).length > 0 ? Object.keys(groups) : [defaultGroup || 'default'];

  async function handleCreate(values: TokenPayload) {
    setCreating(true);
    try {
      await client.createToken(values);
      message.success('令牌创建成功');
      setCreateOpen(false);
      form.resetFields();
      onChanged();
    } catch (createError) {
      message.error(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setCreating(false);
    }
  }

  async function handleToggle(token: TokenItem) {
    const nextStatus = token.status === 1 ? 2 : 1;
    try {
      await client.updateTokenStatus(token.id, nextStatus);
      message.success(nextStatus === 1 ? '已启用' : '已停用');
      onChanged();
    } catch (toggleError) {
      message.error(toggleError instanceof Error ? toggleError.message : String(toggleError));
    }
  }

  async function handleDelete(id: number) {
    try {
      await client.deleteToken(id);
      message.success('令牌已删除');
      onChanged();
    } catch (deleteError) {
      message.error(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  }

  async function handleShowKey(token: TokenItem) {
    setKeyLoadingId(token.id);
    try {
      const fullKey = await client.getTokenKey(token.id);
      setKeyModal({ token, key: fullKey });
    } catch (keyError) {
      message.error(keyError instanceof Error ? keyError.message : String(keyError));
    } finally {
      setKeyLoadingId(null);
    }
  }

  async function handleCopyKey(token: TokenItem) {
    setKeyLoadingId(token.id);
    try {
      const fullKey = await client.getTokenKey(token.id);
      await copyText(fullKey);
      message.success('API Key 已复制');
    } catch (copyError) {
      message.error(copyError instanceof Error ? copyError.message : String(copyError));
    } finally {
      setKeyLoadingId(null);
    }
  }

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
        value === 1 ? <Tag color="green">启用</Tag> : <Tag color="orange">停用</Tag>,
    },
    {
      title: '分组',
      dataIndex: 'group',
      key: 'group',
      width: 110,
      render: (value: string) => value || 'default',
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
    {
      title: '操作',
      key: 'actions',
      width: 280,
      render: (_, record) => (
        <Space size={4} wrap>
          <Button
            size="small"
            icon={<CopyOutlined />}
            loading={keyLoadingId === record.id}
            onClick={() => void handleCopyKey(record)}
          >
            复制密钥
          </Button>
          <Button
            size="small"
            icon={<EyeOutlined />}
            loading={keyLoadingId === record.id}
            onClick={() => void handleShowKey(record)}
          >
            查看密钥
          </Button>
          <Button
            size="small"
            icon={record.status === 1 ? <StopOutlined /> : <CheckCircleOutlined />}
            onClick={() => void handleToggle(record)}
          >
            {record.status === 1 ? '停用' : '启用'}
          </Button>
          <Popconfirm title="确定删除该令牌？" onConfirm={() => void handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <div className="token-toolbar">
        <Typography.Text type="secondary">共 {tokens.length} 个令牌</Typography.Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建令牌
        </Button>
      </div>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={tokens}
        pagination={false}
        size="small"
        loading={loading}
        scroll={{ x: 920, y: 360 }}
      />

      <Modal
        title="新建令牌"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void form.submit()}
        confirmLoading={creating}
        okText="创建"
        cancelText="取消"
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            name: '',
            group: groupOptions[0],
            unlimited_quota: true,
            remain_quota: 0,
            expired_days: -1,
            model_limits_enabled: false,
            allow_ips: '',
          }}
          onFinish={(values) => {
            const payload: TokenPayload = {
              name: values.name,
              group: values.group,
              unlimited_quota: values.unlimited_quota,
              remain_quota: values.unlimited_quota ? 0 : Math.max(0, values.remain_quota || 0),
              expired_time:
                values.expired_days === -1 ? -1 : Math.floor(Date.now() / 1000) + values.expired_days * DAY,
              model_limits_enabled: false,
              model_limits: '',
              allow_ips: values.allow_ips || '',
              cross_group_retry: false,
            };
            void handleCreate(payload);
          }}
        >
          <Form.Item name="name" label="令牌名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如：日常开发" maxLength={50} />
          </Form.Item>
          <Form.Item name="group" label="分组">
            <Select
              options={groupOptions.map((group) => ({
                label: group,
                value: group,
              }))}
            />
          </Form.Item>
          <Form.Item name="unlimited_quota" label="无限额度" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="remain_quota" label="初始额度" dependencies={['unlimited_quota']}>
            <InputNumber
              min={0}
              style={{ width: '100%' }}
              disabled={form.getFieldValue('unlimited_quota')}
              placeholder="额度（quota）"
            />
          </Form.Item>
          <Form.Item name="expired_days" label="过期时间">
            <Select
              options={[
                { label: '永久', value: -1 },
                { label: '1 天后', value: 1 },
                { label: '7 天后', value: 7 },
                { label: '30 天后', value: 30 },
                { label: '365 天后', value: 365 },
              ]}
            />
          </Form.Item>
          <Form.Item name="allow_ips" label="IP 白名单（可选，逗号分隔）">
            <Input placeholder="留空表示不限 IP" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`令牌密钥：${keyModal?.token.name ?? ''}`}
        open={keyModal !== null}
        onCancel={() => setKeyModal(null)}
        footer={[
          <Button key="close" onClick={() => setKeyModal(null)}>
            关闭
          </Button>,
        ]}
      >
        <Typography.Paragraph
          copyable={{ icon: <CopyOutlined />, tooltips: ['复制', '已复制'] }}
          code
          style={{ wordBreak: 'break-all' }}
        >
          {keyModal?.key ?? ''}
        </Typography.Paragraph>
        <Typography.Text type="warning">完整密钥仅在服务端展示一次依据，请妥善保管。</Typography.Text>
      </Modal>
    </>
  );
}
