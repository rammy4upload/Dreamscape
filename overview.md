# Overview

## What it does

| Feature | Description |
|---------|-------------|
| Upload pipeline | Friends, Open Cloud grants, RBXL publish, icon/thumbnail, place IDs |
| Health monitor | Polls game URL; on failure rotates backup account and re-uploads |
| Dashboard | Web UI for config, assets, commands, codes, live logs, manual prompts |
| ProductBridge | Creates/reuses Roblox t-shirts per product key for in-game purchases |
| Promo codes | Dashboard editor; game hot-reloads Lua from `/api/codes/codeslist` |
| Discord | Optional player-count / status voice channels |

## How to run

| Mode | Command / action |
|------|------------------|
| Production | [Railway](./railway.md) — `npm start` via Docker |
| Local server | `npm start` → http://localhost:3000 |
| Local CLI | `npm run cli`, `autoreuploader`, or [LAUNCH.bat](./local-windows.md) |

## Repository layout

```
cli/              CLI commands + reuploader pipeline
src/shared/       robloxClient, promptBridge, placeIdsExport, imageFreshness
server/           Express dashboard + game APIs
assets/           GameVersion script, codes seed, luau/ ProductBridge modules
docs/             Documentation (this folder)
scripts/          INSTALL.bat, LAUNCH.bat
```

### `cli/`

| File | Role |
|------|------|
| `index.js` | CLI parser and dispatch |
| `reuploader.js` | Main automation pipeline |
| `permissions.js` | Open Cloud asset Use grants |
| `rbxlUploadPatch.js` | BUILD_STAMP in game.rbxl |
| `promptBridgeClient.js` | Dashboard prompts for subprocess tasks |

### `src/shared/`

Shared by CLI and server: `robloxClient.js`, `promptBridge.js`, `placeIdsExport.js`, `imageFreshness.js`.

### `server/`

| Path | Role |
|------|------|
| `index.js` | HTTP + WebSocket server |
| `routes/` | dashboard, products, codes, placeids, integration |
| `services/` | Config, assets, codes, products, Railway status |
| `dashboard/static/` | Web UI |

CLI tasks spawn from `server/routes/autoreuploader.js` → `cli/index.js`.
