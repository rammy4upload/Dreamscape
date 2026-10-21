# Automatic developer-product IDs

This feature creates **fixed-reward** developer products for the currently configured universe, verifies the created IDs, and publishes a universe-stamped `productids.json` to the same GitHub repository used for `placeids.json`. The game reads the map through `PlaceIdService:GetProductIds()` and overlays those IDs onto `assets.productId` only after the test-universe override has been applied.

The repository contains a root-level `productids.json` template with 61 sequential placeholder values (`1` through `61`) so the expected shape is visible in GitHub before the first sync. It is stamped with `universeId: 0` and `_template: true`; the Roblox loader explicitly refuses to apply it. These are **not real Roblox product IDs**. Run the authenticated sync endpoint or `npm run syncproducts` to replace the template with actual IDs. A successful Railway response must report `published: true` for the GitHub file to be updated.

## What is synced

`assets/developerProducts.catalog.json` contains the fixed-reward products, including currency packs, named items, named Pokémon/variants, rerolls, and fixed-duration powerups. Paid spin tokens, roulette/lottery purchases, and random-reward products are intentionally excluded from automated creation. Their existing hardcoded `assets.productId` values remain untouched by the merge. Review Roblox's randomized virtual item policy before designing any random-reward monetization.

## Run manually

```bash
npm run syncproducts
```

The CLI resolves the current universe, creates products missing by name, rechecks products after uncertain create responses to reduce duplicate risk, verifies created IDs, and publishes the output map.

## Trigger from Railway

Set `API_KEY` (the Railway endpoint key), `ROBLOX_DEVELOPER_PRODUCTS_API_KEY` (Roblox Open Cloud key), and `GITHUB_TOKEN` (GitHub Contents read/write access). The Roblox Open Cloud key must have `developer-product:read` and `developer-product:write` scopes for the target universe. In `/data/config.json`, set `accountPool.primary.experienceId` to the target **universe ID** and set `placeIds.git.githubOwner`, `githubRepo`, and `githubBranch` to the same repository and branch used by `PlaceIdService` (the included Lua file defaults to `rammy4upload/PlaceIdsRepo`, branch `main`).

Then call the authenticated endpoint:

```bash
curl -X POST "https://YOUR-RAILWAY-DOMAIN/api/developer-products/sync" \
  -H "Authorization: Bearer YOUR_RAILWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

The endpoint rejects concurrent requests within the same server process. It never accepts a universe ID supplied by the caller; it uses the configured target so a caller cannot redirect product creation to another universe.

## Roblox installation

See [`roblox-integration/README.md`](../roblox-integration/README.md). Put `AssetsInit` in `ReplicatedStorage`, `PlaceIdService` and the init Script under `ServerScriptService.AutoReuploader`, and the sync LocalScript in `StarterPlayerScripts`. Merge the overlay block into your existing `Assets` ModuleScript if you do not want to replace that entire module. Keep `PlaceIdService` server-only.

The GitHub repo must be public for the included raw-GitHub loader to work without a token in your game. Do not commit a GitHub or Open Cloud API key into a public repository or a replicated ModuleScript.

## Purchase granting

Creating IDs and loading them does not grant purchased rewards. Use `MarketplaceService:PromptProductPurchase` to prompt a developer product, then route receipts through your experience's **single** `MarketplaceService.ProcessReceipt` callback. Do not use `PromptProductPurchaseFinished` as proof of payment. Keep your existing game reward code; adapt it using `DeveloperProductPurchaseRouter.ProcessFixedRewardReceipt` as documented in the Roblox integration README. The existing product-reward handler is experience-specific and is not replaced automatically by this repository.

## Catalogue configuration

- `developerProducts.enabled`: set to `false` to skip creation.
- `developerProducts.apiKey`: optional Open Cloud key stored in config; prefer Railway variable `ROBLOX_DEVELOPER_PRODUCTS_API_KEY`.
- `developerProducts.defaultPrice`: default for catalog entries missing a price; shipped entries have explicit prices.
- `developerProducts.outputPath`: local JSON output path.
- `developerProducts.githubFilePath`: file path published inside the configured GitHub repo (default `productids.json`).
- `developerProducts.required`: if `true`, sync failures fail the upload; otherwise uploads continue with a warning.

The payload includes `universeId` and `productids`. The Roblox loader refuses to apply a mapping stamped for a different universe and keeps the built-in IDs instead.
