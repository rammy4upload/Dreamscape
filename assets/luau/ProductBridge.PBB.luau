--[[
	Pokemon Brick Bronze AutoReuploader — ProductBridge (PBB)
	Docs: docs/product-bridge.md
	Place as ServerModules/ProductBridge.luau
]]

local HttpService = game:GetService("HttpService")
local MarketplaceService = game:GetService("MarketplaceService")

local serverstorage = game:GetService("ServerStorage"):WaitForChild("src")
local Assets = require(serverstorage:WaitForChild("Assets"))

local ProductBridge = {}

ProductBridge.baseUrl = "__AUTOREUPLOADER_BASE_URL__"
ProductBridge.authToken = "__AUTOREUPLOADER_API_KEY__"

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

local function getProductDef(productKey)
	local defs = Assets.productDefs
	if not defs then
		return nil
	end

	if string.find(productKey, "RoPowers%.") then
		local groupStr, levelStr = string.match(productKey, "^RoPowers%.(%d+)%.(%d+)$")
		local group = tonumber(groupStr)
		local level = tonumber(levelStr)
		local roDefs = defs.RoPowers
		if group and level and roDefs and roDefs[group] and roDefs[group][level] then
			return roDefs[group][level]
		end
		return nil
	end

	return defs[productKey]
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
	local def = getProductDef(productKey)
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
