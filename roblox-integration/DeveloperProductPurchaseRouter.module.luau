-- ServerScriptService.AutoReuploader.DeveloperProductPurchaseRouter (ModuleScript)
-- Routes fixed-reward products created by the catalog. It deliberately does not
-- route spin tokens, roulette, lottery tickets, or randomized-reward products.
-- This module does NOT replace an existing MarketplaceService.ProcessReceipt.

local MarketplaceService = game:GetService("MarketplaceService")
local Players = game:GetService("Players")
local ServerStorage = game:GetService("ServerStorage")

local assetsContainer = ServerStorage:WaitForChild("src")
local Assets = require(assetsContainer:WaitForChild("Assets"))

local Router = {}

local PLACEHOLDER_IDS = {
	[1] = true,
	[12345] = true,
	[676767] = true,
	[67676767] = true,
}

local EXCLUDED_KEYS = {
	PBSpins1 = true,
	PBSpins5 = true,
	PBSpins10 = true,
	PBSpins99 = true,
	RouletteSpinBasic = true,
	RouletteSpinBronze = true,
	RouletteSpinSilver = true,
	RouletteSpinGold = true,
	RouletteSpinDiamond = true,
	LottoTicket = true,
	BasicRoulette = true,
	BronzeRoulette = true,
	SilverRoulette = true,
	GoldRoulette = true,
	DiamondRoulette = true,
	PlatinumRoulette = true,
	ShinyRoulette = true,
	SuperShinyRoulette = true,
	["Random-Shiny-6x31"] = true,
	["Random-6x31"] = true,
	["Random-Shiny"] = true,
}

local function splitPath(path)
	local parts = {}
	for part in tostring(path):gmatch("[^%.]+") do
		parts[#parts + 1] = part
	end
	return parts
end

local function isExcludedPath(path)
	local first = tostring(path):match("^[^%.]+") or tostring(path)
	return EXCLUDED_KEYS[first] == true
end

function Router.GetProductId(productKey)
	local current = Assets.productId
	for _, part in ipairs(splitPath(productKey)) do
		if type(current) ~= "table" then
			return nil
		end
		local numeric = tonumber(part)
		current = current[numeric or part]
	end

	local id = tonumber(current)
	if isExcludedPath(productKey) or not id or id <= 0 or id % 1 ~= 0 or PLACEHOLDER_IDS[id] then
		return nil
	end
	return id
end

local function findKeyForId(tableValue, wantedId, prefix)
	for key, value in pairs(tableValue) do
		local path = prefix == "" and tostring(key) or (prefix .. "." .. tostring(key))
		if type(value) == "table" then
			local found = findKeyForId(value, wantedId, path)
			if found then
				return found
			end
		elseif tonumber(value) == wantedId and not isExcludedPath(path) then
			return path
		end
	end
	return nil
end

function Router.GetProductKey(productId)
	local id = tonumber(productId)
	if not id or id <= 0 or PLACEHOLDER_IDS[id] then
		return nil
	end
	return findKeyForId(Assets.productId, id, "")
end

function Router.Prompt(player, productKey)
	if not player or not player:IsA("Player") then
		return false, "A valid Player is required."
	end
	local productId = Router.GetProductId(productKey)
	if not productId then
		return false, "Unknown, excluded, or invalid developer product key: " .. tostring(productKey)
	end

	local ok, err = pcall(function()
		MarketplaceService:PromptProductPurchase(player, productId)
	end)
	if not ok then
		warn("[DeveloperProductPurchaseRouter] Prompt failed for " .. tostring(productKey) .. ": " .. tostring(err))
		return false, tostring(err)
	end
	return true
end

-- Merge this helper into the experience's ONE existing ProcessReceipt callback.
-- grantProduct(player, productKey, receiptInfo) must use receiptInfo.PurchaseId
-- to make its reward grant idempotent and return true only after saving the reward.
-- Returns nil when the receipt isn't owned by this fixed-reward router, allowing
-- the game's existing callback to handle its other products.
function Router.ProcessFixedRewardReceipt(receiptInfo, grantProduct)
	if type(receiptInfo) ~= "table" then
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end

	local productKey = Router.GetProductKey(receiptInfo.ProductId)
	if not productKey then
		return nil
	end

	local player = Players:GetPlayerByUserId(tonumber(receiptInfo.PlayerId) or -1)
	if not player then
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end
	if type(grantProduct) ~= "function" then
		warn("[DeveloperProductPurchaseRouter] No fixed-reward grant callback was supplied for " .. productKey)
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end

	local ok, granted = pcall(grantProduct, player, productKey, receiptInfo)
	if ok and granted == true then
		return Enum.ProductPurchaseDecision.PurchaseGranted
	end

	if not ok then
		warn("[DeveloperProductPurchaseRouter] Reward grant failed for " .. productKey .. ": " .. tostring(granted))
	else
		warn("[DeveloperProductPurchaseRouter] Reward handler did not confirm saved reward for " .. productKey)
	end
	return Enum.ProductPurchaseDecision.NotProcessedYet
end

return Router
