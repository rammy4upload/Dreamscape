-- ServerScriptService.PlaceIdInit (Script)
-- Reads placeids.json and productids.json from Respi before Assets loads.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")

local assetsModule = require(ReplicatedStorage:WaitForChild("AssetsInit"))

local function getOrCreate(className, name)
	local existing = ReplicatedStorage:FindFirstChild(name)
	if existing and existing.ClassName == className then
		return existing
	end
	if existing then
		existing:Destroy()
	end
	local object = Instance.new(className)
	object.Name = name
	object.Parent = ReplicatedStorage
	return object
end

local updateEvent = getOrCreate("RemoteEvent", "UpdateAssetList")
local getAssetList = getOrCreate("RemoteFunction", "GetAssetList")

local serviceOk, PlaceIdService = pcall(function()
	return require(
		ServerScriptService:WaitForChild("AutoReuploader"):WaitForChild("PlaceIdService")
	)
end)

local function snapshot()
	return {
		INITIALIZED = assetsModule.INITIALIZED,
		RTD = assetsModule.RTD,
		ProductIds = assetsModule.ProductIds,
	}
end

getAssetList.OnServerInvoke = function(_player)
	-- PlaceIdInit performs HTTP requests before marking the module initialized.
	-- A client may invoke this RemoteFunction during that window, so wait briefly
	-- rather than returning a false/uninitialized snapshot.
	local deadline = os.clock() + 20
	while not assetsModule.INITIALIZED and os.clock() < deadline do
		task.wait(0.1)
	end
	return snapshot()
end

local function installAssets()
	local RTD = {
		Main = assetsModule.RTD.Main,
		Battle = assetsModule.RTD.Battle,
		Trade = assetsModule.RTD.Trade,
	}

	if serviceOk and PlaceIdService then
		local placeOk, ids = pcall(function()
			return PlaceIdService:Get()
		end)
		if placeOk and type(ids) == "table" then
			RTD.Main = tonumber(ids.MainPlaceId) or RTD.Main
			RTD.Battle = tonumber(ids.BattlePlaceId) or RTD.Battle
			RTD.Trade = tonumber(ids.TradePlaceId) or RTD.Trade
		else
			warn("[PlaceIdInit] PlaceIdService:Get() failed; keeping fallback place IDs.")
		end

		local productsOk, products = pcall(function()
			return PlaceIdService:GetProductIds()
		end)
		if productsOk and type(products) == "table" then
			assetsModule.ProductIds = products
		else
			assetsModule.ProductIds = nil
			warn("[PlaceIdInit] No matching product ID mapping loaded; built-in product IDs will be kept.")
		end
	else
		warn("[PlaceIdInit] PlaceIdService could not be required; using built-in IDs.")
		assetsModule.ProductIds = nil
	end

	assetsModule.RTD = RTD
	assetsModule.INITIALIZED = true
	print(string.format(
		"[PlaceIdInit] RTD Main=%s Battle=%s Trade=%s; dynamic product IDs=%s",
		tostring(RTD.Main),
		tostring(RTD.Battle),
		tostring(RTD.Trade),
		assetsModule.ProductIds and "loaded" or "not loaded"
	))

	updateEvent:FireAllClients(snapshot())
end

-- Connect before the HTTP reads below. Players can join while installAssets() yields.
Players.PlayerAdded:Connect(function(player)
	task.spawn(function()
		local deadline = os.clock() + 25
		while not assetsModule.INITIALIZED and os.clock() < deadline do
			task.wait(0.1)
		end
		if player.Parent then
			updateEvent:FireClient(player, snapshot())
		end
	end)
end)

installAssets()

print("--- PLACE + DEVELOPER PRODUCT ID SYNC READY ---")
