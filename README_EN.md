<div align=center>
<img src="icon.png" style="width:100px;" width="100"/>
<h2>NewApiApp</h2>
</div>

### 1. Overview
- A desktop and mobile client for the [QuantumNous/new-api](https://github.com/QuantumNous/new-api) relay panel, connected through the panel REST API.
- Configure the relay root URL, username and password to sign in; the app adapts to the site's login password encryption (RSA-OAEP for short passwords, RSA-wrapped AES-256-GCM for longer ones).
- Sessions are persisted locally and access tokens are refreshed automatically when expired; an expired session returns to the login screen.
- Desktop: a dashboard for balance, usage, top-up, check-in, subscriptions and tokens, with one-click API key copying and an always-on-top floating balance window. Data is refreshed automatically after the host wakes from sleep, screen-off or lock.
- Mobile: a dashboard-style interface for checking balance, request statistics and token status at any time.

### 2. Tech Stack
- Mobile: React Native + TypeScript + AsyncStorage
- Desktop: Tauri 2 + React + TypeScript + antd
- API: new-api panel REST API (panel endpoints under `/api`, relay endpoints under `/v1`)

### 3. Project Structure
```text
NewApiApp/
├── desktop/   Tauri + React + antd desktop client
└── mobile/    React Native mobile client
```

### 4. Application IDs
- Android / iOS package: `org.mutantcat.newapiapp`
- Desktop Tauri Identifier: `org.mutantcat.newapi.desktop`
- Application name: `NewApiApp`

### 5. Quick Start
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

> macOS packaging note: DMG bundling calls `SetFile`, which resolves through the active Xcode developer directory. If Xcode is selected but its license has never been accepted, bundling fails at the last step; the build script then points `DEVELOPER_DIR` at Command Line Tools and finishes the job. Run `sudo xcodebuild -license accept` to switch back for good.

### 6. API Surface
- `GET /api/status`: site status, version and quota display configuration
- `GET /api/user/login/encryption-key`: login password encryption public key and key ID
- `POST /api/user/login`: password login
- `POST /api/user/auth/refresh`: refresh the access token
- `POST /api/user/auth/logout`: revoke the current login session
- `GET /api/user/self`: current user, quota and usage
- `GET /api/token/`: paged API token list
- `POST /api/token/`: create a token
- `PUT /api/token/?status_only=1`: enable or disable a token
- `POST /api/token/{id}/key`: fetch the full token key
- `DELETE /api/token/{id}`: delete a token
- `GET /api/log/self/stat`: daily quota, RPM and TPM statistics
- `GET /api/log/self`: recent usage logs
- `GET /api/data/self`: daily usage trend
- `GET /api/notice`: site notice
- `GET /api/user/self/groups`: group information
- `GET /api/user/models`: available models
- `GET /api/user/topup/info`: top-up information
- `POST /api/user/topup`: redeem a top-up key
- `GET /api/user/topup/self`: top-up history
- `GET /api/user/checkin`: check-in status
- `POST /api/user/checkin`: perform a check-in
- `GET /api/user/aff`: invitation code
- `GET /api/subscription/plans`: subscription plans
- `GET /api/subscription/self`: current subscription

### 7. Known Limitations
- Accounts with login verification enabled (2FA, passkeys and similar) must complete one verification pass on the website first; in-app verification is not supported yet.
- Sites with Cloudflare Turnstile login checks cannot be used, since a third-party client cannot obtain a Turnstile token.
- Only username/password login is supported; OAuth, GitHub, OIDC and other third-party sign-in methods are out of scope.

### 8. Roadmap
- [x] Project scaffolding for both clients
- [x] Unified application name and package IDs
- [x] Mobile new-api client
- [x] Mobile dashboard UI
- [x] Desktop login and dashboard UI
- [x] Desktop floating balance window
- [x] Login password encryption (RSA-OAEP / AES-256-GCM hybrid)
- [x] Automatic access token refresh with session-expiry fallback to login
- [x] Paged token aggregation, enable/disable, delete and one-click key copying
- [x] Top-up history, check-in, subscription and daily usage dashboard
- [x] Automatic refresh after host sleep, lock or screen-off recovery

### 9. Release
Push a tag that matches the desktop version and GitHub Actions builds and publishes the release:

```sh
git tag v1.0.20260924
git push origin v1.0.20260924
```

The tag has to match the `version` in `desktop/src-tauri/tauri.conf.json`; the workflow checks that first and fails fast on a mismatch. Versions use plain date increments (for example `1.0.20260924`) and must not carry `-1` or `-2` suffixes. Release assets:

| Platform | Architecture | Format |
| --- | --- | --- |
| Windows | x86_64 | NSIS installer (`.exe`) |
| macOS | Apple Silicon | ad-hoc signed DMG |
| macOS | Intel | ad-hoc signed DMG |
| Linux | x86_64 / arm64 | AppImage |
| Android | all architectures | directly installable release APK (debug certificate) |

A `checksums.txt` ships alongside them. Tags work with or without the `v` prefix.

---

中文版本: [README.md](README.md)
