import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { KeyOutlined, LinkOutlined, LoginOutlined, UserOutlined } from '@ant-design/icons';
import { NewApiClient, loadSession } from '../api';

type LoginFormValues = {
  baseUrl: string;
  username: string;
  password: string;
};

type LoginCardProps = {
  onLoggedIn: () => void;
};

export default function LoginCard({ onLoggedIn }: LoginCardProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form] = Form.useForm<LoginFormValues>();

  async function handleFinish(values: LoginFormValues) {
    setLoading(true);
    setError('');
    try {
      const client = new NewApiClient(values.baseUrl);
      await client.passwordLogin(values.username, values.password);
      if (loadSession()) {
        onLoggedIn();
      }
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <Card className="login-card" bordered={false}>
        <div className="login-brand">
          <span className="login-logo">N</span>
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>
              NewApiApp
            </Typography.Title>
            <Typography.Text type="secondary">new-api 中转站桌面客户端</Typography.Text>
          </div>
        </div>
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 16 }}>
          填写中转站根地址，使用面板账号密码登录，即可查看余额、用量与令牌。
        </Typography.Paragraph>
        {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}
        <Form<LoginFormValues>
          form={form}
          layout="vertical"
          initialValues={{ baseUrl: 'https://' }}
          onFinish={handleFinish}
        >
          <Form.Item
            label="中转站根地址"
            name="baseUrl"
            rules={[
              { required: true, message: '请输入中转站根地址' },
              { pattern: /^https?:\/\//, message: '地址需以 http:// 或 https:// 开头' },
            ]}
          >
            <Input
              prefix={<LinkOutlined />}
              placeholder="https://api.example.com"
              autoComplete="url"
              allowClear
            />
          </Form.Item>
          <Form.Item
            label="账号"
            name="username"
            rules={[{ required: true, message: '请输入账号' }]}
          >
            <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" allowClear />
          </Form.Item>
          <Form.Item
            label="密码"
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              prefix={<KeyOutlined />}
              placeholder="密码"
              autoComplete="current-password"
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" block loading={loading} icon={<LoginOutlined />}>
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
