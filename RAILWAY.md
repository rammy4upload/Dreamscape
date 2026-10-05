# Railway deployment

One service runs the dashboard, upload task runner, ProductBridge API, and promo codes API.

## Checklist

1. Connect repo to Railway (`Dockerfile` + `railway.toml` auto-detected).
2. **Add volume** mounted at `/data` (required — data lost on redeploy without it).
3. **Generate domain** (e.g. `autoreuploader-production.up.railway.app`).
4. Set variables below → deploy → verify `/health`.
5. Open dashboard → upload assets and config.
6. Wire game: [ProductBridge guide](./product-bridge.md).

## Environment variables

See [`.env.example`](../.env.example). Required:

| Variable | Purpose |
|----------|---------|
| `API_KEY` | ProductBridge + codes auth |
| `DASHBOARD_PASSWORD` | Dashboard / task API lock |
| `DATA_DIR` | `/data` |
| `CONFIG_PATH` | `/data/config.json` |
| `TSHIRT_TEMPLATE_PATH` | `/data/tshirt-template.png` |
| `HEADLESS` | `1` |
| `WEB_PROMPTS` | `1` |

Optional: `ROBLOX_COOKIE`, `PLACEIDS_GITHUB_TOKEN`, `PUBLIC_BASE_URL`.

Also set in config (Configuration tab):

```json
"gameIntegration": {
  "publicBaseUrl": "https://autoreuploader-production.up.railway.app"
}
```

URL priority: `RAILWAY_PUBLIC_DOMAIN` → `PUBLIC_BASE_URL` → `gameIntegration.publicBaseUrl`.

## First-time setup

1. Sign in with `DASHBOARD_PASSWORD`.
2. **Assets** — upload `config.json`, `game.rbxl`, `icon.png`, `thumbnail.png`.
3. **Configuration** — fill accounts, experience ids, `gameIntegration.publicBaseUrl` → Save.
4. **Commands** — run tasks; keep tab open for manual prompts during permission flows.

## Persistent `/data` files

| File | Purpose |
|------|---------|
| `config.json` | Accounts, monitor, integration URL |
| `game.rbxl`, `icon.png`, `thumbnail.png` | Upload assets |
| `products.json` | T-shirt catalog |
| `placeids.json` | Main / Battle / Trade IDs |
| `codes.json`, `codes.lua` | Promo codes |

## Place IDs on Railway

Local `git push` does not work in Docker. Use:

- **GitHub API** — `PLACEIDS_GITHUB_TOKEN` + `placeIds.git.githubOwner` / `githubRepo`
- **HTTP** — `GET /api/placeids` with `Authorization: Bearer <API_KEY>`
- **Dashboard** — Configuration → Push to GitHub

## Headless behavior

| Automated | Needs dashboard **Continue** |
|-----------|------------------------------|
| RBXL, Open Cloud, media | Friend captchas, group rank, universe Edit grants |
| | Roblox Studio unavailable — use Creator Dashboard in browser |

Recommended: `normalupload` / `rbxlupload` for publish-only; `fullupload` / `grantpermissions` with dashboard open.

## Local dev (optional)

```bash
npm install && cp .env.example .env
npm start       # dashboard on :3000
npm run cli     # terminal-only
```
