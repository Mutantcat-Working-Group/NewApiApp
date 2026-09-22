<div align=center>
<img src="icon.png" style="width:100px;" width="100"/>
<h2>NewApiApp</h2>
</div>

### 一、产品概述

- 面向 [QuantumNous/new-api](https://github.com/QuantumNous/new-api) 中转站的桌面 + 移动双端客户端，通过面板 REST API 接入。
- 支持填写中转站根地址、账号和密码登录；自动适配站点的登录密码加密方式（RSA-OAEP 直加密，超长密码使用 RSA 包裹 AES-256-GCM）。
- 登录会话本地持久化，访问令牌过期自动刷新；会话失效自动回到登录页。
- 桌面端：看板展示余额、用量、充值、签到、订阅和令牌，支持一键复制 API Key；提供常驻悬浮余额窗，宿主机休眠、锁屏或屏幕关闭恢复后自动重新拉取数据。
- 移动端：看板式界面，随时查看余额、请求统计和令牌状态。

### 二、功能说明

#### 桌面端看板

- 余额、用量、充值、签到、订阅和令牌一屏总览。
- 一键复制 API Key，令牌支持翻页聚合、启停与删除。
- 常驻悬浮余额窗，宿主机休眠、锁屏或屏幕关闭恢复后自动刷新数据。

#### 移动端看板

- 看板式界面，随时查看余额、请求统计和令牌状态。
- 签到、充值记录与订阅信息随时可查。

#### 登录与会话

- 填写中转站根地址、账号和密码即可登录。
- 自动适配站点登录密码加密方式，访问令牌过期自动刷新。
- 会话失效自动回到登录页，无需手动清理。

### 三、安装与下载

从 [Releases](https://github.com/Mutantcat-Working-Group/NewApiApp/releases) 下载对应平台安装包：

| 平台 | 架构 | 格式 |
| --- | --- | --- |
| Windows | x86_64 | NSIS 安装包（`.exe`） |
| macOS | Apple Silicon | ad-hoc 签名 DMG |
| macOS | Intel | ad-hoc 签名 DMG |
| Linux | x86_64 / arm64 | AppImage |
| Android | 全架构通用包 | 可直接安装的 release APK（debug 证书签名） |

另附 `checksums.txt` 供校验。版本号使用纯日期递增（如 `1.0.20260924`），推送与桌面端版本一致的标签（`v` 前缀可选）后，GitHub Actions 会自动构建并发布 Release；标签必须和 `desktop/src-tauri/tauri.conf.json` 里的 `version` 一致，流水线会先校验，不一致直接失败。

### 四、快速上手

1. 安装并打开应用，填写中转站根地址、账号和密码登录。
2. 登录后进入看板，查看余额、今日额度、RPM/TPM 与令牌状态。
3. 需要 API Key 时一键复制；充值、签到、订阅均可直接在应用内完成。
4. 桌面端可开启悬浮余额窗，随时掌握剩余额度。

### 五、接口说明

应用通过 new-api 面板 REST API 与站点通信（面板接口在 `/api`，中转接口在 `/v1`）：

- `GET /api/status`：站点状态、版本和额度展示配置
- `GET /api/user/login/encryption-key`：登录密码加密公钥与密钥 ID
- `POST /api/user/login`：账号密码登录
- `POST /api/user/auth/refresh`：刷新访问令牌
- `POST /api/user/auth/logout`：吊销当前登录会话
- `GET /api/user/self`：当前用户、余额和用量
- `GET /api/token/`：分页获取 API 令牌
- `POST /api/token/`：创建令牌
- `PUT /api/token/?status_only=1`：启用或停用令牌
- `POST /api/token/{id}/key`：获取令牌完整密钥
- `DELETE /api/token/{id}`：删除令牌
- `GET /api/log/self/stat`：今日额度、RPM、TPM 统计
- `GET /api/log/self`：最近用量日志
- `GET /api/data/self`：每日用量趋势
- `GET /api/notice`：站点公告
- `GET /api/user/self/groups`：分组信息
- `GET /api/user/models`：可用模型列表
- `GET /api/user/topup/info`：充值信息
- `POST /api/user/topup`：兑换充值码
- `GET /api/user/topup/self`：充值记录
- `GET /api/user/checkin`：签到状态
- `POST /api/user/checkin`：执行签到
- `GET /api/user/aff`：邀请码
- `GET /api/subscription/plans`：订阅套餐
- `GET /api/subscription/self`：当前订阅

### 六、技术栈与工程结构

- 移动端：React Native + TypeScript + AsyncStorage
- 桌面端：Tauri 2 + React + TypeScript + antd
- 接口协议：new-api 面板 REST API

```text
NewApiApp/
├── desktop/   Tauri + React + antd 桌面端
└── mobile/    React Native 移动端
```

应用标识：

- Android / iOS 包名：`org.mutantcat.newapiapp`
- 桌面端 Tauri Identifier：`org.mutantcat.newapi.desktop`
- 应用名称：`NewApiApp`

### 七、已知限制

- 账号若开启了登录验证（2FA、通行密钥等），需先在网页端完成一次验证流程，应用内暂不支持验证步骤。
- 站点若开启了 Cloudflare Turnstile 登录校验，第三方客户端无法取得校验令牌，因而无法登录。
- 仅支持账号密码登录，OAuth / GitHub / OIDC 等第三方登录方式不在范围内。

### 八、从源码构建

移动端：

```sh
cd mobile
npm install
npm start
```

桌面端：

```sh
cd desktop
npm install
npm run tauri dev
```

> macOS 打包说明：DMG 打包会调用 `SetFile`，该命令经由当前 Xcode 开发者目录解析。若本机选中了 Xcode 但从未接受许可协议，打包会在最后一步失败；此时脚本会自动把 `DEVELOPER_DIR` 指向 Command Line Tools 继续完成。想彻底恢复原状可执行 `sudo xcodebuild -license accept`。

### 九、开发进度

- [x] 双端工程初始化
- [x] 应用名与包名统一
- [x] 移动端 new-api 客户端
- [x] 移动端看板 UI
- [x] 桌面端登录与看板 UI
- [x] 桌面端悬浮余额窗
- [x] 登录密码加密（RSA-OAEP / AES-256-GCM 混合）
- [x] 访问令牌自动刷新与会话过期回登录页
- [x] 令牌列表翻页聚合、启停、删除与一键复制密钥
- [x] 充值记录、签到、订阅和每日用量看板
- [x] 宿主机休眠、锁屏或屏幕关闭恢复后自动刷新

---

English version: [README_EN.md](README_EN.md)
