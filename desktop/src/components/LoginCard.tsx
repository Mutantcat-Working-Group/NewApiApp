import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import {
  KeyOutlined,
  LinkOutlined,
  LoginOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { LoginVerificationRequiredError, NewApiClient, loadSession } from '../api';
import type { LoginChallenge } from '../types';

type LoginFormValues = {
  baseUrl: string;
  username: string;
  password: string;
};

type LoginCardProps = {
  onLoggedIn: () => void;
  /** Why the previous session ended, so the login screen can explain itself. */
  notice?: string;
};

type PendingVerification = {
  client: NewApiClient;
  challenge: LoginChallenge;
  baseUrl: string;
  username: string;
};

export default function LoginCard({ onLoggedIn, notice }: LoginCardProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [verification, setVerification] = useState<PendingVerification | null>(null);
  const [verificationCode, setVerificationCode] = useState('');
  const [form] = Form.useForm<LoginFormValues>();

  async function handleFinish(values: LoginFormValues) {
    setLoading(true);
    setError('');
    try {
      const client = new NewApiClient(values.baseUrl);
      try {
        await client.passwordLogin(values.username, values.password);
      } catch (loginError) {
        if (loginError instanceof LoginVerificationRequiredError) {
          setVerification({
            client,
            challenge: loginError.challenge,
            baseUrl: values.baseUrl,
            username: values.username,
          });
          setVerificationCode('');
          setError('');
          return;
        }
        throw loginError;
      }
      if (loadSession()) {
        onLoggedIn();
      }
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify() {
    if (!verification) {
      return;
    }
    setLoading(true);
    setError('');
    try {
      await verification.client.verifyLogin(
        verification.challenge.flow_token,
        verificationCode,
      );
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
          <img src="/icon.png" alt="NewApiApp" className="login-logo" />
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
        {notice ? (
          <Alert type="error" showIcon message={notice} style={{ marginBottom: 16 }} />
        ) : null}
        {verification ? (
          <Form layout="vertical" onFinish={() => void handleVerify()}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
              {verification.baseUrl} · {verification.username}
            </Typography.Paragraph>
            <Form.Item
              label="动态验证码"
              required
              style={{ marginBottom: 12 }}
            >
              <Input
                prefix={<SafetyCertificateOutlined />}
                placeholder="请输入 2FA 动态验证码"
                value={verificationCode}
                onChange={(event) => setVerificationCode(event.target.value)}
                autoFocus
                allowClear
              />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={loading}
              icon={<LoginOutlined />}
            >
              验证并登录
            </Button>
            <Button
              type="link"
              block
              style={{ marginTop: 8 }}
              onClick={() => {
                setVerification(null);
                setVerificationCode('');
              }}
            >
              返回上一步
            </Button>
          </Form>
        ) : (
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
        )}
      </Card>
    </div>
  );
}
