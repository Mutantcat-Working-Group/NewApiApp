<div align=center>
<img src="icon.png" style="width:120px;" width="120"/>
<h1>NewApiApp</h1>
</div>

<p align="center">读写 new-api 中转站面板的桌面 + 移动双端客户端。默认展示中文，英文版本见下方 <a href="#english">English</a>。</p>

### 一、功能简述
- 面向 [QuantumNous/new-api](https://github.com/QuantumNous/new-api) 的双端客户端工具。
- 支持填写中转站根地址、账号和密码，通过 new-api 面板 REST API 接入。
- 登录会话本地持久化，访问令牌过期后自动刷新。
- 桌面端支持查看账号余额、用量和令牌，后续提供常驻悬浮余额窗。
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

### 六、接口清单
- `GET /api/status`：获取站点状态、版本和额度展示配置
- `POST /api/user/login`：账号密码登录
- `POST /api/user/auth/refresh`：刷新访问令牌
- `GET /api/user/self`：获取当前用户、余额和用量
- `GET /api/token/`：分页获取 API 令牌
- `GET /api/log/self/stat`：获取今日额度、RPM、TPM 统计

### 七、开发进度
- [x] 双端工程初始化
- [x] 应用名与包名统一
- [x] 移动端 new-api 客户端
- [ ] 移动端看板 UI
- [ ] 桌面端登录与看板 UI
- [ ] 桌面端悬浮余额窗

---

## English

<div align=center>
<img src="icon.png" style="width:120px;" width="120"/>
<h1>NewApiApp</h1>
</div>

### Overview
- A desktop and mobile client for the QuantumNous new-api panel.
- Configure the relay root URL, username and password, then connect through the new-api panel REST API.
- Sessions are persisted locally and access tokens are refreshed automatically when expired.
- The desktop client shows balance, usage and tokens, with a floating balance window planned.
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

### API Surface
- `GET /api/status`: site status, version and quota display configuration
- `POST /api/user/login`: password login
- `POST /api/user/auth/refresh`: refresh the access token
- `GET /api/user/self`: current user, quota and usage
- `GET /api/token/`: paged API token list
- `GET /api/log/self/stat`: daily quota, RPM and TPM statistics

### Roadmap
- [x] Project scaffolding for both clients
- [x] Unified application name and package IDs
- [x] Mobile new-api client
- [ ] Mobile dashboard UI
- [ ] Desktop login and dashboard UI
- [ ] Desktop floating balance window
