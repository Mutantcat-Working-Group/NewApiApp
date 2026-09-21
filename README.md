<div align=center>
<img src="icon.png" style="width:120px;" width="120"/>
<h1>NewApiApp</h1>
</div>

<p align="center">读写 new-api 中转站面板的桌面 + 移动双端客户端。默认展示中文，英文版本见下方 <a href="#english">English</a>。</p>

### 一、功能简述
- 面向 [QuantumNous/new-api](https://github.com/QuantumNous/new-api) 的双端客户端工具。
- 支持填写中转站根地址、账号和密码，通过 new-api 面板 REST API 接入。
- 自动适配站点是否开启登录密码加密：短密码走 RSA-OAEP(SHA-256) 直加密，超出模长容量时走 RSA 包裹 AES-256-GCM 混合加密。
- 登录会话本地持久化，访问令牌过期后自动刷新。
- 桌面端支持查看账号余额、用量和令牌，并提供常驻悬浮余额窗。
- 移动端采用看板式界面，便于随时查看余额、请求统计和令牌状态。

### 二、技术栈
- 移动端：React Native + TypeScript + AsyncStorage。
- 桌面端：Tauri 2 + React + TypeScript + antd。
- 接口协议：new-api 面板 REST API，登录接口位于 `/api`，中转接口位于 `/v1`。

### 三、工程结构
```text
NewApiApp/
├── desktop/   Tauri + React + antd 桌面端
└── mobile/    React Native 移动端
```

### 四、应用标识
- Android / iOS 包名：`org.mutantcat.newapiapp`
- 桌面端 Tauri Identifier：`org.mutantcat.newapi.desktop`
- 应用名称：`NewApiApp`

### 五、快速开始
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

### 六、接口清单
- `GET /api/status`：获取站点状态、版本和额度展示配置
- `GET /api/user/login/encryption-key`：获取登录密码加密公钥与密钥 ID
- `POST /api/user/login`：账号密码登录
- `POST /api/user/auth/refresh`：刷新访问令牌
- `POST /api/user/auth/logout`：通知服务端吊销当前登录会话
- `GET /api/user/self`：获取当前用户、余额和用量
- `GET /api/token/`：分页获取 API 令牌
- `GET /api/log/self/stat`：获取今日额度、RPM、TPM 统计

### 七、已知限制
- 账号若开启了登录验证（2FA、通行密钥等），需先在网页端完成一次验证流程，应用内暂不支持验证步骤。
- 站点若开启了 Cloudflare Turnstile 登录校验，第三方客户端无法取得校验令牌，因而无法登录。
- 仅支持账号密码登录，OAuth / GitHub / OIDC 等第三方登录方式不在范围内。

### 八、开发进度
- [x] 双端工程初始化
- [x] 应用名与包名统一
- [x] 移动端 new-api 客户端
- [x] 移动端看板 UI
- [x] 桌面端登录与看板 UI
- [x] 桌面端悬浮余额窗
- [x] 登录密码加密（RSA-OAEP / AES-256-GCM 混合）
- [x] 访问令牌自动刷新与会话过期回登录页
- [x] 令牌列表翻页聚合
- [x] 登出时通知服务端吊销会话

### 九、发布流程
推送一个与桌面端版本号一致的标签，GitHub Actions 会自动构建并发布 Release：

```sh
git tag v1.0.20260922
git push origin v1.0.20260922
```

标签必须和 `desktop/src-tauri/tauri.conf.json` 里的 `version` 一致，流水线会先校验，不一致直接失败。发布资产：

| 平台 | 架构 | 格式 |
| --- | --- | --- |
| Windows | x86_64 | NSIS 安装包（`.exe`） |
| macOS | Apple Silicon | ad-hoc 签名 DMG |
| macOS | Intel | ad-hoc 签名 DMG |
| Linux | x86_64 / arm64 | AppImage |
| Android | 全架构通用包 | 可直接安装的 release APK（debug 证书签名） |

另附一份 `checksums.txt`。标签可以带 `v` 前缀，也可以不带。

---

## English

<div align=center>
<img src="icon.png" style="width:120px;" width="120"/>
<h1>NewApiApp</h1>
</div>

### Overview
- A desktop and mobile client for the QuantumNous new-api panel.
- Configure the relay root URL, username and password, then connect through the new-api panel REST API.
- Adapts to the site's password encryption setting: short passwords are sealed directly with RSA-OAEP(SHA-256), longer ones with RSA-wrapped AES-256-GCM.
- Sessions are persisted locally and access tokens are refreshed automatically when expired.
- The desktop client shows balance, usage and tokens, plus an always-on-top floating balance window.
- The mobile client uses a dashboard layout for quick access to balance, request statistics and tokens.

### Tech Stack
- Mobile: React Native + TypeScript + AsyncStorage.
- Desktop: Tauri 2 + React + TypeScript + antd.
- API: new-api panel REST API; panel endpoints live under `/api` and relay endpoints under `/v1`.

### Project Structure
```text
NewApiApp/
├── desktop/   Tauri + React + antd desktop client
└── mobile/    React Native mobile client
```

### Application IDs
- Android / iOS package: `org.mutantcat.newapiapp`
- Desktop Tauri Identifier: `org.mutantcat.newapi.desktop`
- Application name: `NewApiApp`

### Quick Start
Mobile:
```sh
cd mobile
npm install
npm start
```

Desktop:
```sh
cd desktop
npm install
npm run tauri dev
```

> macOS packaging note: DMG bundling calls `SetFile`, which resolves through the active Xcode developer directory. If Xcode is selected but its license has never been accepted, bundling fails at the very last step; the build script then points `DEVELOPER_DIR` at Command Line Tools and finishes the job. Run `sudo xcodebuild -license accept` to switch back for good.

### API Surface
- `GET /api/status`: site status, version and quota display configuration
- `GET /api/user/login/encryption-key`: login password encryption public key and key ID
- `POST /api/user/login`: password login
- `POST /api/user/auth/refresh`: refresh the access token
- `POST /api/user/auth/logout`: revoke the current login session on the server
- `GET /api/user/self`: current user, quota and usage
- `GET /api/token/`: paged API token list
- `GET /api/log/self/stat`: daily quota, RPM and TPM statistics

### Known Limitations
- Accounts with login verification enabled (2FA, passkeys and similar) must complete one verification pass on the website first; in-app verification is not supported yet.
- Sites with Cloudflare Turnstile login checks cannot be used, since a third-party client cannot obtain a Turnstile token.
- Only username/password login is supported; OAuth, GitHub, OIDC and other third-party sign-in methods are out of scope.

### Roadmap
- [x] Project scaffolding for both clients
- [x] Unified application name and package IDs
- [x] Mobile new-api client
- [x] Mobile dashboard UI
- [x] Desktop login and dashboard UI
- [x] Desktop floating balance window
- [x] Login password encryption (RSA-OAEP / AES-256-GCM hybrid)
- [x] Automatic access token refresh with session-expiry fallback to login
- [x] Paged token list aggregation
- [x] Session revocation on logout

### Release
Push a tag that matches the desktop version and GitHub Actions builds and publishes the release:

```sh
git tag v1.0.20260922
git push origin v1.0.20260922
```

The tag has to match the `version` in `desktop/src-tauri/tauri.conf.json`; the workflow checks that first and fails fast on a mismatch. Release assets:

| Platform | Architecture | Format |
| --- | --- | --- |
| Windows | x86_64 | NSIS installer (`.exe`) |
| macOS | Apple Silicon | ad-hoc signed DMG |
| macOS | Intel | ad-hoc signed DMG |
| Linux | x86_64 / arm64 | AppImage |
| Android | all architectures | directly installable release APK (debug certificate) |

A `checksums.txt` ships alongside them. Tags work with or without the `v` prefix.
