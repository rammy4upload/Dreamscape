# Manual patch for the pasted gameplay scripts

The attached ZIPs do not contain the specific Marketplace receipt / Rewards / Ro-Powers game modules that were pasted in chat. Apply the following small changes in those existing modules. Keep the one existing `MarketplaceService.ProcessReceipt` callback; do not add a second one.

## 1. Block fake sentinel product IDs in the existing receipt handler

In the existing Marketplace server script, replace `getValidProductId` with:

```lua
local MIN_VALID_PRODUCT_ID = 1000
local INVALID_PRODUCT_IDS = { [676767] = true, [67676767] = true }

local function getValidProductId(value)
    local id = tonumber(value)
    if not id or id < MIN_VALID_PRODUCT_ID or id ~= math.floor(id) or INVALID_PRODUCT_IDS[id] then
        return nil
    end
    return id
end
```

This rejects both the template IDs `1..64` and the large `676767` / `67676767` sentinels used in the pasted `Assets` table. Do not treat those sentinels as sellable products.

Make the same blacklist check in the pasted `PlaceIdService` validator and the client `RoPowers` `validProductId` function: add `local INVALID_PRODUCT_IDS = { [676767] = true, [67676767] = true }` near the minimum-ID constant and include `or INVALID_PRODUCT_IDS[id]` in each invalid-ID condition. The bundled `PlaceIdService` already does this.

## 2. Fix quest-reroll product-name logging

Delete the incorrect line `addProductName("QuestRerolls", "**Quest Rerolls**")`—`QuestRerolls` is a table, not a single numeric ID. After the `QR` table and `addRerollProduct` helper are declared, add:

```lua
local function addRerollProductName(rawId, displayName)
    local id = getValidProductId(rawId)
    if id and configuredProductIds[id] then
        productNames[id] = displayName
    end
end

addRerollProductName(QR.x1, "**Quest Rerolls x1**")
addRerollProductName(QR.x3, "**Quest Rerolls x3**")
addRerollProductName(QR.x10, "**Quest Rerolls x10**")
```

Keep the existing `REROLL_PRODUCTS` map and its reward logic unchanged.

## 3. Do not acknowledge purchased rerolls when the save failed

Replace `R.grantRerolls` in the existing Rewards module with:

```lua
function R.grantRerolls(pd, count)
    if not pd or not pd.gameBegan then return false, 'no player' end

    local current = load(pd)
    local ok, work = pcall(function()
        return HttpService:JSONDecode(HttpService:JSONEncode(current))
    end)
    if not ok or type(work) ~= 'table' then
        return false, 'could not copy reward data'
    end

    local amount = math.max(1, math.floor(tonumber(count) or 1))
    work.extraRerolls = math.max(0, math.floor(tonumber(work.extraRerolls) or 0)) + amount

    -- ProcessReceipt must return NotProcessedYet if persistent saving fails.
    if not persist(pd, work) then
        return false, 'save failed'
    end

    pd.Rewards = work
    pd.RewardsMode = cleanMode(pd.gamemode)
    return true, work.extraRerolls
end
```

Your existing receipt handler already throws / returns `NotProcessedYet` when `grantRerolls` returns `false`, so that failure will correctly be retried by Roblox.

## 4. Product-ID repository must match in both places

The bundled `roblox-integration/PlaceIdService.module.luau` currently targets `lagingtalo72-cloud/Respi`, matching the bundled `config.json`. The pasted code instead points at `lagingtalo72-cloud/Respi`. Pick the repository you actually use and make both sides match exactly: `OWNER`, `REPO`, `BRANCH`, `PRODUCT_PATH` in Lua and `placeIds.git.githubOwner`, `githubRepo`, `githubBranch`, `developerProducts.githubFilePath` in Railway config. The repository must be public for Roblox's `raw.githubusercontent.com` GET request to work without a secret in the game.
