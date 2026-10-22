# Developer Product ID sync

This route turns the checked-in `productids.json` template into a universe-specific mapping of real Roblox Developer Product IDs, writes the result back to GitHub, and stores a local copy under `/data/productids.json`.

## Supported product types

The built-in whitelist supports currencies, items, the three explicit `Random-*` products whose rewards are dispatched by the existing receipt handler, RO-Powers, and Quest Rerolls. It intentionally does **not** sync roulette, lottery, or paid-spin products. This route creates IDs/metadata only; it does not implement the rewards.

## Required Railway variables

- `API_KEY`: protects `POST /api/developer-products/sync`.
- `ROBLOX_UNIVERSE_ID`: the target universe ID (or set `accountPool.primary.experienceId` in `config.json`). The template universeId is ignored on first sync; it no longer blocks changing target universes.
- `ROBLOX_OPEN_CLOUD_API_KEY`: Roblox Open Cloud API key with `developer-product:read` and `developer-product:write` scoped to this universe.
- `PLACEIDS_GITHUB_TOKEN` (or `GITHUB_TOKEN`): GitHub contents-write token.
- The AutoReuploader config must have `placeIds.git.enabled=true`, the correct `githubOwner`, `githubRepo`, and `githubBranch`. The sync endpoint derives the `productids.json` path beside the configured `placeids.json`; set `PRODUCTIDS_GITHUB_FILE_PATH` to override that path.

Upload the provided root `productids.json` template to the configured GitHub repository before syncing. The script deliberately ignores the template's placeholder universe ID and refuses to continue if the target universe is not configured.

## Run the sync

```bash
curl -X POST \
  'https://YOUR-RAILWAY-HOST/api/developer-products/sync' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

The endpoint reuses legacy product IDs only when Roblox's product listing confirms they belong to the configured universe. Otherwise it reuses a previously managed product by name or creates a product using `productDefinitions`. Products with no known legacy ID and no configured `priceRobux` are created with sales disabled, not with an invented price. Add the correct `priceRobux` and rerun the sync to enable them.

On success the endpoint removes `_template` and `_notice`, writes real IDs to `productids`, preserves `productDefinitions` for future idempotent syncs, and commits the result to GitHub. It is safe to rerun after updating a price or adding a valid legacy ID.

`GET /api/developer-products/ids?universeId=10038436051` returns `{ "productId": ... }` for clients that use the generated-ID endpoint. The endpoint only returns published mappings and never returns API keys.
