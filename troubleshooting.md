# Troubleshooting

## Railway / dashboard

| Issue | Fix |
|-------|-----|
| Data lost on redeploy | Attach volume at `/data`; check `/health` → `volumeBacked` |
| Dashboard prompts time out | Keep Commands tab open; answer **Manual prompt** |
| `autoreuploader` not found | Run `INSTALL.bat` → `npm link`, or use `LAUNCH.bat` |
| Wrong config picked up | Pass `--config` with absolute path |
| Service runs too often | Increase `monitor.intervalMs` in config |

## Upload / RBXL

| Issue | Fix |
|-------|-----|
| RBXL stamp warning | Add `GameVersion.server.luau` to place; re-export `game.rbxl` |
| Place IDs not pushing (Railway) | Set `PLACEIDS_GITHUB_TOKEN` + `placeIds.git.githubOwner` / `githubRepo` |
| Studio steps on Railway | Use Creator Dashboard in browser (dashboard screenshots) |

## ProductBridge

| Issue | Fix |
|-------|-----|
| HTTP 401 | `ProductBridge.authToken` ≠ Railway `API_KEY` |
| HttpService blocked | Allowlist hostname in Roblox (no `https://`) |
| Wrong URL in Luau | Set `gameIntegration.publicBaseUrl`; re-download module |
| `Unknown product key` | Add key to `Assets.productDefs` |
| Purchase OK, no reward | Wire `PromptPurchaseFinished` → `onProductPurchased` |
| Codes not updating | Test `GET .../api/codes/codeslist?key=<API_KEY>` in browser |
