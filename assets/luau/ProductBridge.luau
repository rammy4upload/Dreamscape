--[[
	Monster Brick Bronze AutoReuploader — ProductBridge (generic template)
	Docs: docs/product-bridge.md
]]

local HttpService = game:GetService("HttpService")
local MarketplaceService = game:GetService("MarketplaceService")

local ProductBridge = {}

ProductBridge.baseUrl = "__AUTOREUPLOADER_BASE_URL__"
ProductBridge.authToken = "__AUTOREUPLOADER_API_KEY__"

--[[
	Optional product lookup: function(productKey) -> { displayName: string, priceRobux: number }?
	Example:
		ProductBridge.getProductDef = function(productKey)
			return require(path.to.Assets).productDefs[productKey]
		end
]]
ProductBridge.getProductDef = nil

local function normalizeBaseUrl(url)
	if not url or url == "" then
		return ""
	end

	local trimmed = url:gsub("/+$", "")
	if not trimmed:find("^https?://") then
		trimmed = "https://" .. trimmed
	end

	return trimmed
end

function ProductBridge.getBaseUrl()
	return normalizeBaseUrl(ProductBridge.baseUrl)
end

local assetToProductKey = {}
local pendingByAssetId = {}

local function resolveProductDef(productKey)
	if ProductBridge.getProductDef then
		return ProductBridge.getProductDef(productKey)
	end
	return nil
end

function ProductBridge.registerMapping(assetId, productKey)
	assetToProductKey[tonumber(assetId) or assetId] = productKey
end

function ProductBridge.getProductKeyForAsset(assetId)
	return assetToProductKey[tonumber(assetId) or assetId]
end

function ProductBridge.trackPendingPurchase(player, assetId, productKey)
	pendingByAssetId[player.UserId] = pendingByAssetId[player.UserId] or {}
	pendingByAssetId[player.UserId][tonumber(assetId) or assetId] = productKey
end

function ProductBridge.consumePendingPurchase(player, assetId)
	local userPending = pendingByAssetId[player.UserId]
	if not userPending then
		return nil
	end
	local key = tonumber(assetId) or assetId
	local productKey = userPending[key]
	userPending[key] = nil
	return productKey
end

function ProductBridge.resolveForPlayer(player, productKey)
	local def = resolveProductDef(productKey)
	if not def then
		warn("[ProductBridge] Unknown product key:", productKey)
		return nil
	end

	local body = HttpService:JSONEncode({
		userId = player.UserId,
		productKey = productKey,
		displayName = def.displayName or productKey,
		priceRobux = def.priceRobux,
	})

	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = ProductBridge.getBaseUrl() .. "/api/products/resolve",
			Method = "POST",
			Headers = {
				["Content-Type"] = "application/json",
				["Authorization"] = "Bearer " .. ProductBridge.authToken,
			},
			Body = body,
		})
	end)

	if not ok or not response.Success then
		warn("[ProductBridge] Resolve failed for", productKey, response)
		return nil
	end

	local data = HttpService:JSONDecode(response.Body)
	if not data or not data.assetId then
		warn("[ProductBridge] Invalid resolve payload for", productKey, response.Body)
		return nil
	end

	ProductBridge.registerMapping(data.assetId, productKey)
	ProductBridge.trackPendingPurchase(player, data.assetId, productKey)
	return data.assetId
end

function ProductBridge.promptPurchase(player, productKey)
	local assetId = ProductBridge.resolveForPlayer(player, productKey)
	if not assetId then
		return false
	end
	MarketplaceService:PromptPurchase(player, assetId)
	return true
end

return ProductBridge
