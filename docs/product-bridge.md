# ProductBridge

ProductBridge replaces legacy **Developer Products** with **dynamic Roblox t-shirts**. The game POSTs to your server; the server returns an `assetId`; the player buys the shirt; your game grants the item.

**Prerequisite:** [Railway deploy](./railway.md) (or `npm start` locally) with `API_KEY` set.

## Flow

1. `ProductBridge.promptPurchase(player, productKey)`
2. POST `/api/products/resolve` → get `assetId`
3. `MarketplaceService:PromptPurchase(player, assetId)`
4. `PromptPurchaseFinished` → `consumePendingPurchase` → grant item

Promo codes use the same URL + key: `GET /api/codes/codeslist?key=<API_KEY>` (~60s poll).

---

## Public URL config

Downloaded Luau gets `baseUrl` auto-filled. Set URL in one place (first wins):

| Priority | Source |
|----------|--------|
| 1 | `RAILWAY_PUBLIC_DOMAIN` (auto) |
| 2 | `PUBLIC_BASE_URL` env |
| 3 | `config.json` → `gameIntegration.publicBaseUrl` |

`ProductBridge.authToken` must equal Railway **`API_KEY`**.

---

## Download Luau

| Source | URL |
|--------|-----|
| Repo (PBB) | [assets/luau/ProductBridge.PBB.luau](../assets/luau/ProductBridge.PBB.luau) |
| Repo (generic) | [assets/luau/ProductBridge.luau](../assets/luau/ProductBridge.luau) |
| Live manifest | `https://<domain>/api/integration/manifest` |
| Live PBB module | `https://<domain>/api/integration/luau/ProductBridge.PBB.luau` |
| Dashboard (+ API key) | `https://<domain>/api/dashboard/integration/luau/ProductBridge.PBB.luau?includeSecrets=1` |

Repo placeholders: `__AUTOREUPLOADER_BASE_URL__`, `__AUTOREUPLOADER_API_KEY__`.

Example: [autoreuploader-production.up.railway.app/api/integration/manifest](https://autoreuploader-production.up.railway.app/api/integration/manifest)

---

## Roblox game settings

1. Enable **HttpService**
2. Allowlist hostname only (no `https://`): e.g. `autoreuploader-production.up.railway.app`

---

## PBB copy wiring

For **Pokemon Brick Bronze**

### 1. Add module

Save as `ServerStorage/ArmoryModule/Shovels/ServerModules/ProductBridge` (ModuleScript).

Paste [ProductBridge.PBB.luau](../assets/luau/ProductBridge.PBB.luau). Requires:

```lua
local serverstorage = game:GetService("ServerStorage"):WaitForChild("src")
local Assets = require(serverstorage:WaitForChild("Assets"))
```

### 2. SDriver

In `SDriver/init.server.luau`, include `'ProductBridge'` in the module list (before purchase handlers):

```lua
for _, name in pairs({'Network', 'Context', 'DataService', 'Elo', 'BattleEngine', 'Backend', 'ProductBridge'}) do
```

### 3. Assets.productDefs

In `ServerStorage/src/Assets.luau`:

```lua
assets.productDefs = {
	CandyPurchase = { displayName = "Candy Purchase", priceRobux = 125 },
	Starter = { displayName = "Starter Pack", priceRobux = 15 },
	RoPowers = {
		{ { displayName = "XP RoPower L1", priceRobux = 5 } },
		-- RoPowers keys: "RoPowers.<group>.<level>"
	},
}
```

Keys must match what shop UI passes to `promptProductPurchase`.

### 4. PlayerDataService — prompt

```lua
function PlayerData:promptProductPurchase(productKey)
	if _f.ProductBridge and Assets.productDefs[productKey] then
		return _f.ProductBridge.promptPurchase(self.player, productKey)
	end
	local legacyId = Assets.productId[productKey]
	if legacyId then
		MarketplaceService:PromptProductPurchase(self.player, legacyId)
		return true
	end
	return false
end
```

### 5. Marketplace — fulfill

```lua
marketplaceService.PromptPurchaseFinished:connect(function(player, assetId, isPurchased)
	if isPurchased then
		local productKey = _f.ProductBridge and (
			_f.ProductBridge.consumePendingPurchase(player, assetId)
				or _f.ProductBridge.getProductKeyForAsset(assetId)
		)
		if productKey and _f.PlayerDataService[player] then
			_f.PlayerDataService[player]:onProductPurchased(productKey)
		end
	end
end)
```

### 6. Promo codes

PBB-style `PlayerDataService:refreshCodes()` uses `ProductBridge.getBaseUrl()` + `authToken` automatically when loaded. Edit codes in dashboard **Codes** tab.

### 7. Publish & verify

- [ ] `/health` OK · URL + API key match · HttpService allowlisted
- [ ] `productDefs` has every shop key · SDriver loads ProductBridge
- [ ] Marketplace wired · game published
- [ ] Test purchase → check dashboard **T-Shirts** tab

---

## Generic game (non-PBB)

Use [ProductBridge.luau](../assets/luau/ProductBridge.luau):

```lua
ProductBridge.getProductDef = function(productKey)
	return MyCatalog[productKey] -- { displayName, priceRobux }
end
```

```lua
MarketplaceService.PromptPurchaseFinished:Connect(function(player, assetId, isPurchased)
	if isPurchased and ProductBridge then
		local key = ProductBridge.consumePendingPurchase(player, assetId)
			or ProductBridge.getProductKeyForAsset(assetId)
		if key then /* grant */ end
	end
end)
```

---

## GitHub Releases

Attach `assets/luau/` to a release for frozen offline downloads.

See also: [Troubleshooting](./troubleshooting.md#productbridge)
