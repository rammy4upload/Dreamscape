# Roblox assets / Developer Product ID sync installation

These files are intended for Roblox Studio. The repository's `assets/luau/ProductBridge.PBB.luau` is a separate legacy asset/T-shirt resolver; do not use it to prompt Developer Products.

## 1. Install the ID loader

Create these instances (names must match):

- `ReplicatedStorage.AssetsInit` — ModuleScript from `AssetsInit.module.luau`.
- `ServerScriptService.AutoReuploader.PlaceIdService` — ModuleScript from `PlaceIdService.module.luau`.
- `ServerScriptService.PlaceIdInit` — Script from `PlaceIdInit.server.luau`.
- `StarterPlayer.StarterPlayerScripts.PlaceIdClientSync` — LocalScript from `PlaceIdClientSync.client.luau`.

Make sure `ServerScriptService.AutoReuploader` exists. Enable **Allow HTTP Requests** in Experience Settings → Security. The included service points at `rammy4upload/PlaceIdsRepo`, branch `main`; change those constants if your actual public repository is elsewhere. This raw-GitHub loader requires the repository/files to be publicly readable.

## 2. Update your Assets ModuleScript

`Assets.module.luau` is a full copy based on the Assets code supplied in the request, with the `ProductIds` overlay placed after the `if game.CreatorId == 1` branch. It preserves the existing animation IDs, pass IDs, badge IDs, and other fields. Use it only if the supplied copy is still your current Assets module. Otherwise, add the block below immediately before `return assets` in your current Assets module:

```lua
local function overlay(target, source)
    for key, value in pairs(source) do
        if type(value) == "table" and type(target[key]) == "table" then
            overlay(target[key], value)
        else
            target[key] = value
        end
    end
end

if type(assetsInit.ProductIds) == "table" then
    overlay(assets.productId, assetsInit.ProductIds)
end
```

Do not place this block before the test-game branch: that branch replaces `assets.productId` and would discard the mapping. The service validates the `universeId` stamp, so IDs from another universe are ignored.

## 3. Sync and publish IDs

On Railway, add:

- `API_KEY`: random secret used to authenticate the Railway sync endpoint.
- `ROBLOX_DEVELOPER_PRODUCTS_API_KEY`: Roblox Open Cloud key for the target universe with `developer-product:read` and `developer-product:write` scopes.
- `GITHUB_TOKEN`: GitHub token with Contents read/write for the configured PlaceIdsRepo.

Set `/data/config.json`'s `accountPool.primary.experienceId` to the universe ID (not a place ID) and configure `placeIds.git.githubOwner`, `githubRepo`, and `githubBranch`.

Trigger via `npm run syncproducts` on the CLI or `POST /api/developer-products/sync` on Railway. Product IDs are written to `productids.json` at the repo root. Confirm the request reports `published: true`; otherwise the file may have been saved locally only.

## 4. Purchases are a separate step

Use `DeveloperProductPurchaseRouter.module.luau` as a helper for fixed-reward products. It prompts with `MarketplaceService:PromptProductPurchase`, not `PromptPurchase`. It intentionally refuses placeholder IDs and does not route paid spins, roulette/lottery entries, or random-reward entries.

`ProcessFixedRewardReceipt(receiptInfo, grantProduct)` is an adapter, not a complete reward implementation. In your existing one-and-only `MarketplaceService.ProcessReceipt` callback, call it first for the fixed rewards and return its decision when it returns one. If it returns `nil`, let your existing callback process its other products. The `grantProduct(player, productKey, receiptInfo)` function must call your game's existing reward logic, save the grant, use `receiptInfo.PurchaseId` to avoid duplicate rewards, and return `true` only after the reward is safely saved. Do not create a second `ProcessReceipt` callback and do not use `PromptProductPurchaseFinished` to grant purchases.

A general-purpose module cannot safely invent your game's actual rewards because those grant methods live in your game code, not in this repository. Keep that existing purchase code and connect it to this helper.
