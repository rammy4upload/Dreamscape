-- StarterPlayerScripts.PlaceIdClientSync (LocalScript)
-- Connect to updates first, then request a snapshot so the first event can't be missed.

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local assetsInitModule = ReplicatedStorage:WaitForChild("AssetsInit")
local assetsInit = require(assetsInitModule)
local updateEvent = ReplicatedStorage:WaitForChild("UpdateAssetList")
local getAssetList = ReplicatedStorage:WaitForChild("GetAssetList")

local function applySnapshot(data)
	if type(data) ~= "table" then
		return
	end
	if type(data.RTD) == "table" then
		assetsInit.RTD = data.RTD
	end
	if data.ProductIds == nil or type(data.ProductIds) == "table" then
		assetsInit.ProductIds = data.ProductIds
	end
	if data.INITIALIZED == true then
		assetsInit.INITIALIZED = true
	end
end

updateEvent.OnClientEvent:Connect(applySnapshot)

local ok, snapshot = pcall(function()
	return getAssetList:InvokeServer()
end)
if ok then
	applySnapshot(snapshot)
else
	warn("[PlaceIdClientSync] Could not fetch the initial AssetsInit snapshot: " .. tostring(snapshot))
end
