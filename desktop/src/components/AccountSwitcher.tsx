import { useState } from 'react';
import { Avatar, Button, Dropdown, Empty, Modal, Popconfirm, Space, Tag, Typography } from 'antd';
import type { MenuProps } from 'antd';
import {
  CheckOutlined,
  DeleteOutlined,
  DownOutlined,
  PlusOutlined,
  SettingOutlined,
  SwapOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { accountIdOf, hostOf } from '../api';
import type { StoredSession } from '../api';

type AccountSwitcherProps = {
  accounts: StoredSession[];
  activeAccountId: string | null;
  onSwitch: (accountId: string) => void;
  onRemove: (accountId: string) => void;
  onAdd: () => void;
};

function accountName(session: StoredSession): string {
  return session.user?.display_name || session.user?.username || hostOf(session.baseUrl);
}

export default function AccountSwitcher({
  accounts,
  activeAccountId,
  onSwitch,
  onRemove,
  onAdd,
}: AccountSwitcherProps) {
  const [manageOpen, setManageOpen] = useState(false);
  const active = accounts.find((item) => accountIdOf(item) === activeAccountId) ?? null;

  const items: MenuProps['items'] = [
    ...accounts.map((account) => {
      const id = accountIdOf(account);
      const isActive = id === activeAccountId;
      return {
        key: `switch:${id}`,
        label: (
          <div className="account-menu-item">
            <div className="account-menu-name">
              {accountName(account)}
              {isActive ? <CheckOutlined className="account-menu-check" /> : null}
            </div>
            <div className="account-menu-host">{hostOf(account.baseUrl)}</div>
          </div>
        ),
      };
    }),
    { type: 'divider' as const },
    { key: 'add', icon: <PlusOutlined />, label: '添加账号' },
    { key: 'manage', icon: <SettingOutlined />, label: '账号管理' },
  ];

  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'add') {
      onAdd();
      return;
    }
    if (key === 'manage') {
      setManageOpen(true);
      return;
    }
    if (key.startsWith('switch:')) {
      const id = key.slice('switch:'.length);
      if (id !== activeAccountId) {
        onSwitch(id);
      }
    }
  };

  return (
    <>
      <Dropdown
        menu={{ items, onClick: handleMenuClick, selectedKeys: activeAccountId ? [activeAccountId] : [] }}
        trigger={['click']}
        placement="bottomRight"
      >
        <Button icon={<UserOutlined />}>
          <span className="account-switcher-label">
            {active ? accountName(active) : '账号'}
          </span>
          <DownOutlined />
        </Button>
      </Dropdown>
      <Modal
        open={manageOpen}
        title="账号管理"
        onCancel={() => setManageOpen(false)}
        footer={[
          <Button
            key="add"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setManageOpen(false);
              onAdd();
            }}
          >
            添加账号
          </Button>,
          <Button key="close" onClick={() => setManageOpen(false)}>
            关闭
          </Button>,
        ]}
      >
        {accounts.length === 0 ? (
          <Empty description="暂无已登录账号" />
        ) : (
          <div className="account-manage-list">
            {accounts.map((account) => {
              const id = accountIdOf(account);
              const isActive = id === activeAccountId;
              return (
                <div key={id} className="account-manage-row">
                  <Avatar icon={<UserOutlined />} size={36} />
                  <div className="account-manage-main">
                    <Space size={6} wrap>
                      <Typography.Text strong>{accountName(account)}</Typography.Text>
                      {isActive ? <Tag color="blue">当前</Tag> : null}
                    </Space>
                    <Typography.Text type="secondary" className="account-manage-host">
                      {hostOf(account.baseUrl)}
                    </Typography.Text>
                  </div>
                  <Space size={4}>
                    <Button
                      size="small"
                      icon={<SwapOutlined />}
                      disabled={isActive}
                      onClick={() => {
                        setManageOpen(false);
                        onSwitch(id);
                      }}
                    >
                      切换
                    </Button>
                    <Popconfirm
                      title="移除该账号？"
                      description="将清除本机保存的登录状态。"
                      okText="移除"
                      cancelText="取消"
                      onConfirm={() => onRemove(id)}
                    >
                      <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                </div>
              );
            })}
          </div>
        )}
      </Modal>
    </>
  );
}
