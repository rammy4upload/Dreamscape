# Local Windows setup

## Install

Run **`INSTALL.bat`** (or `scripts/INSTALL.bat`):

1. `npm install`
2. Optional `npm link` → global `autoreuploader` command

## Configure

1. Copy [`config.example.json`](../config.example.json) → **`config.json`**
2. Fill credentials, paths, asset lists
3. Place `game.rbxl`, `icon.png`, `thumbnail.png` (or set paths in config)
4. Optional: add [`assets/GameVersion.server.luau`](../assets/GameVersion.server.luau) in Studio for upload stamping

## Launch

Run **`LAUNCH.bat`** (or `scripts/LAUNCH.bat`) for an interactive menu, or:

```bash
autoreuploader --fullupload --config ./config.json
node cli/index.js --reupload --config ./config.json
```

| Menu | Flag |
|------|------|
| Full upload | `--fullupload` |
| Normal upload | `--normalupload` |
| Reupload | `--reupload` |
| Health service | `--service` |
| Help | `--help` |

Full command list: [CLI commands](./cli.md).

## Place IDs (local)

Set `placeIds.git.repositoryPath` to a local git clone for normal `git push`. On Railway use GitHub API instead — see [Railway deploy](./railway.md#place-ids-on-railway).
