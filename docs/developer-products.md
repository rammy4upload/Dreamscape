# Automatic developer products

After every reupload (`--reupload`, `--normalupload`, `--fullupload`, `--pushplaceids`) the reuploader:

1. reads `assets/developerProducts.catalog.json` (76 products, mirrors `assets.productId`),
2. creates any product that doesn't exist yet in the new universe (Open Cloud, matched by name, so re-runs never duplicate),
3. verifies every ID is visible in the universe,
4. writes `productids.json` and pushes it to the PlaceIdsRepo (same token/route as `placeids.json`).

The game reads that file (see `luau/`) and overlays it on `assets.productId`.

Run it alone: `npm run syncproducts` (errors are shown instead of swallowed).

## Required Open Cloud key scopes
`developer-product:read` + `developer-product:write` on the experience. Put the key in
`developerProducts.apiKey`, or the reuploader falls back to the key it already uses for publishing
(which must then have those scopes too). Without them: sync logs a warning and the reupload continues.

## Catalog
`path` mirrors the Lua table (`RoPowers.2.1` = `assets.productId.RoPowers[2][1]`). Entries without a
`price` use `developerProducts.defaultPrice` (default 100) and log a warning.

## Config (`developerProducts`)
`enabled` (default true) · `apiKey` · `defaultPrice` · `catalogPath` · `outputPath` · `githubFilePath`
(default `productids.json`) · `commitMessage` · `required` (true = fail the reupload if sync fails)
