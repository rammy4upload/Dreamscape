# Railway deployment

The Monster Brick Bronze AutoReuploader is designed as one Railway service with a persistent `/data` volume. The service hosts the dashboard, protected APIs, task runner, automatic recovery/monitoring, Roblox publishing helpers, Discord status/statistics, promo-code API, and ProductBridge downloads.

## 1. Railway service setup

Create one service from this repository and keep the bundled `Dockerfile`/`railway.toml` deployment configuration.

Attach a **persistent Railway Volume** to the service and mount it at `/data`. Railway volumes provide persistent storage across deployments; files outside the volume are ephemeral. citeturn272546search3turn272546search5

Generate a Railway public domain and set the environment variables from `.env.example`.

## 2. Required environment variables

```text
API_KEY=<YOUR_API_KEY>
CODES_API_KEY=<YOUR_CODES_API_KEY>
DASHBOARD_PASSWORD=<YOUR_DASHBOARD_PASSWORD>
DATA_DIR=/data
CONFIG_PATH=/data/config.json
TSHIRT_TEMPLATE_PATH=/data/tshirt-template.png
HEADLESS=1
WEB_PROMPTS=1
GITHUB_TOKEN=<YOUR_GITHUB_TOKEN>
ROBLOX_COOKIE=<YOUR_ROBLOX_COOKIE>
ROBLOX_USER_ID=<YOUR_ROBLOX_USER_ID>
ROBLOX_GROUP_ID=<YOUR_ROBLOX_GROUP_ID>
PUBLIC_BASE_URL=https://<YOUR_RAILWAY_DOMAIN>
```

`CODES_API_KEY` may be left unset when the API should use `API_KEY`. `ROBLOX_COOKIE`, user ID, and group ID can be supplied through `/data/config.json` instead, but the secrets should never be committed to source control.

Discord is configured through `DISCORD_BOT_TOKEN` or the `monitor.discordBotToken` config field. The default IDs are already set for the requested status/statistics channels:

```text
Main status report: 1557731440676966420
System voice status: 1226004017394614325
Favorites:          1275393071089192960
Visits:              1275393127993311253
Players:             1275393110213656667
```

## 3. Persistent data

The service uses `/data` for important state:

| File | Purpose |
|---|---|
| `config.json` | Persistent runtime configuration |
| `config.json.bak` | Last known-good config backup |
| `operations.json` | Persistent operation journal and recovery states |
| `operation.lock` | Cross-process operation lock |
| `dashboard-auth.json` | Dashboard session epoch |
| `discord-state.json` | Discord message/channel/stat state |
| `products.json` | Product/T-shirt mapping |
| `codes.json`, `codes.lua` | Promo code data |
| `placeids.json` | Exported Main/Battle/Trade place IDs |
| `game.rbxl`, `icon.png`, `thumbnail.png` | Persistent upload assets |
| `tshirt-template.png` | Persistent T-shirt template |

Writes use atomic replacement and backups so a process crash does not intentionally leave the primary JSON file half-written.

## 4. Health endpoints

`GET /health` is a liveness endpoint for Railway. It returns success when the service process and persistent data directory are available.

`GET /ready` is the application readiness endpoint. It separates application readiness from external Roblox health and reports `HEALTHY`, `DEGRADED`, or `DOWN` information.

Railway healthchecks are primarily deployment-time readiness checks rather than continuous monitoring, so the app also runs its own persistent monitor worker. citeturn272546search4

## 5. Automatic recovery

The server starts the monitor and statistics workers automatically unless `AUTO_MONITOR=0` or `monitor.autoMonitor=false`.

Before an operation starts, it receives a persistent ID and is written as `PENDING`/`RUNNING`. After the remote action, it enters `VERIFYING`. Only a successful verification produces `SUCCESS`.

When Railway restarts during an operation, incomplete entries are marked `RECOVERY_REQUIRED`. On startup the recovery scan verifies the current Roblox experience state. If Roblox shows the expected experience as healthy, the interrupted operation can be marked recovered-successfully; otherwise it remains recoverable and the monitor can schedule another repair attempt.

## 6. Discord behavior

The application maintains one editable status-report message rather than posting an unlimited stream of status messages.

System states are:

```text
🟢 UP
🟡 REUPLOADING
🔴 DOWN
```

The system voice channel uses exactly those state names. Statistics are polled from Roblox and update only when the authoritative value changes:

```text
《⭐》Favorites: <number>
《👁️》Visits: <number>
《👥》Playing: <number>
```

Roblox exposes a game-detail endpoint and a dedicated favorites-count endpoint for these statistics. citeturn272546search0turn272546search2

Discord failures are intentionally isolated from the primary Roblox operation. A Discord outage leaves the last known statistic values intact and does not convert a successful Roblox upload into a failed upload.

## 7. Deployment commands

Build is handled by the provided Dockerfile. Runtime command:

```text
node server/index.js
```

The bundled Dockerfile sets:

```text
DATA_DIR=/data
CONFIG_PATH=/data/config.json
TSHIRT_TEMPLATE_PATH=/data/tshirt-template.png
PORT=3000
```

## 8. Migration from the existing Railway service

1. Deploy the new service with a new or replacement Railway service.
2. Attach the `/data` volume before the first production upload.
3. Copy the existing `config.json`, `game.rbxl`, `icon.png`, `thumbnail.png`, `codes.json`/`codes.lua`, `products.json`, and `placeids.json` into `/data`.
4. Set environment variables using `.env.example` placeholders, replacing only on Railway with the real secret values.
5. Verify `/health`, then `/ready` from the Railway public domain.
6. Open the dashboard and confirm the account pool, experience IDs, monitor URL, and Discord IDs.
7. Run `normalupload` once as the compatibility verification step.
8. Confirm the Discord report/status/statistics channels update correctly.
9. Enable the automatic monitor and leave the old uploader offline so two independent services cannot repair the same experience simultaneously.

## 9. Important Railway storage rule

Do not rely on `/app` for persistent state. Railway service files outside the attached volume are ephemeral and can be lost between deployments. citeturn272546search14
