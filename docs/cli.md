# CLI commands

Default when no command given: **`--reupload`**.

```bash
autoreuploader --help
autoreuploader --fullupload --config ./config.json
autoreuploader --service
npm run cli          # same as --reupload
npm run fullupload
```

## Commands

| Command | RBXL / media | Friends / grants | Updates health URL |
|---------|--------------|------------------|-------------------|
| `--fullupload` | Yes | Yes | Yes |
| `--normalupload` | Yes | No | Yes |
| `--reupload` | On health failure | No | Yes |
| `--service` | On failure (loop) | No | Yes |
| `--grantpermissions` | No | Yes | No |
| `--addfriends` | No | Friends only | No |
| `--rbxlupload` | RBXL only | No | No |
| `--configureexperience` | Media only | No | No |
| `--pushplaceids` | Place IDs only | No | No |
| `--channelstatusservice` | Discord only | No | No |
| `--add-backup-account` | No | Interactive setup | No |

### Key differences

- **`--fullupload`** — Always runs full pipeline including permissions.
- **`--reupload`** — One-shot: skips if health URL OK; else rotates backup → `--normalupload`.
- **`--service`** — Long-running `--reupload`-style loop at `monitor.intervalMs`.

## Config: `monitor`

```json
"monitor": {
  "healthUrl": "https://www.roblox.com/games/<MainPlaceId>",
  "intervalMs": 600000
}
```

Minimum `intervalMs`: 10000. Default: 600000 (10 min).

## npm scripts

| Script | Runs |
|--------|------|
| `npm start` | Web server |
| `npm run cli` | `--reupload` |
| `npm run fullupload` | `--fullupload` |
| `npm run service` | `--service` |
| `npm test` | Syntax check |
