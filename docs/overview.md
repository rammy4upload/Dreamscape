# Overview

## What it does

| Feature | Description |
|---------|-------------|
| Upload pipeline | Friends, Open Cloud grants, RBXL publish, icon/thumbnail, place IDs |
| Health monitor | Polls game URL; on failure rotates uploader account (if configured) and can rotate to a separate backup Universe |
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


## Backup Universes

The reuploader supports a separate `experienceBackups` pool for switching the live game to a different Roblox Universe after a health-check failure. Each configured backup has a `universeId` and `placeIds` for `Main`, `Battle`, and `Trade`.

If `Battle` or `Trade` is omitted, the uploader attempts to create that place from `experience.templatePlaceId` the first time the backup is activated, then stores the new place ID in `config.json`. The backup is **not marked active until Main/Battle/Trade configuration, RBXL publishing, and media configuration finish successfully**.

The existing `accountPool.backups` feature is still separate: it rotates the Roblox uploader account/cookie. `experienceBackups` rotates the actual game Universe. They can be used together.

## Discord Announcements

Set `monitor.discordAnnouncementChannelId` to a dedicated announcement channel and `monitor.discordAnnouncementMention` to `@everyone` or `@here`. When the monitor confirms the game is down, it posts the configured down notice. After a successful normal/full/backup upload, it posts the full restored-game announcement with the current Main place link.

### Backup Universe configuration

The Railway dashboard accepts the backup Universe IDs as one comma-separated field. Enter only the Universe IDs, for example:

```text
123456789, 234567890, 345678901
```

The dashboard automatically stores them internally as `Backup_1`, `Backup_2`, `Backup_3`, etc. Each backup keeps its own `Main`, `Battle`, and `Trade` place IDs. If Battle or Trade is blank for a backup, the uploader can create the missing place from `experience.templatePlaceId` when that backup is activated.

Equivalent internal configuration:

```json
"experienceBackups": [
  {
    "name": "Backup_1",
    "universeId": "123456789",
    "placeIds": { "Main": "", "Battle": "", "Trade": "" }
  },
  {
    "name": "Backup_2",
    "universeId": "234567890",
    "placeIds": { "Main": "", "Battle": "", "Trade": "" }
  }
]
```


### Automatic questionnaire and public privacy

During the experience configure step, the reuploader automatically fetches the latest Roblox experience questionnaire and submits one answer for every question. The current strategy matches the supplied reference behavior: the first available option is selected for each question. Questionnaire failures are logged as warnings and do not stop the rest of the reupload.

The same configure step then sets the universe to public (`isFriendsOnly: false`, `privacyType: "Public"`). Roblox currently uses content labels such as **Minimal** as the result of its content-maturity system; the questionnaire submission is what supplies the content answers, while `Public` controls audience availability.

This can be disabled with `experience.questionnaire.enabled = false`.
