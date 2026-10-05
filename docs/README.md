# Documentation

## Guides

| Guide | Contents |
|-------|----------|
| [Overview](./overview.md) | What this project does, repo layout |
| [Railway deploy](./railway.md) | Production setup, env vars, dashboard, `/data` volume |
| [Local Windows](./local-windows.md) | `INSTALL.bat`, `LAUNCH.bat`, `config.json` |
| [CLI commands](./cli.md) | `--fullupload`, `--reupload`, `--service`, monitor config |
| [ProductBridge](./product-bridge.md) | Luau modules, PBB copy wiring, HttpService, codes |
| [HTTP API](./api.md) | Dashboard, products, codes, place IDs, Luau downloads |
| [Troubleshooting](./troubleshooting.md) | Common fixes |

## Luau files (in repo)

| File | Use |
|------|-----|
| [assets/luau/ProductBridge.PBB.luau](../assets/luau/ProductBridge.PBB.luau) | PBB / Armory forks |
| [assets/luau/ProductBridge.luau](../assets/luau/ProductBridge.luau) | Generic template |

Live downloads: `https://<your-domain>/api/integration/manifest`

Example: [autoreuploader-production.up.railway.app/api/integration/manifest](https://autoreuploader-production.up.railway.app/api/integration/manifest)
