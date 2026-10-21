-- ServerScriptService.AutoReuploader.PlaceIdService (ModuleScript)
-- Keep this module in ServerScriptService, not ReplicatedStorage.
-- The repository should be public so Roblox servers can read the raw JSON files
-- without a GitHub token embedded in the experience.

local HttpService = game:GetService("HttpService")

local PlaceIdService = {}

local OWNER = "rammy4upload"
local REPO = "PlaceIdsRepo"
local BRANCH = "main"
local PLACE_PATH = "placeids.json"
local PRODUCT_PATH = "productids.json"

local FALLBACK_PLACES = {
	MainPlaceId = 98612974463740,
	BattlePlaceId = 93554540746402,
	TradePlaceId = 123484754024352,
}

local MAX_ATTEMPTS = 4
local PRODUCT_ATTEMPTS = 3
local placeCache
local productCache

local function rawUrl(filePath)
	return string.format(
		"https://raw.githubusercontent.com/%s/%s/%s/%s",
		OWNER,
		REPO,
		BRANCH,
		filePath
	)
end

local function requestJson(filePath)
	local response = HttpService:RequestAsync({
		Url = rawUrl(filePath),
		Method = "GET",
	})

	if not response.Success then
		return nil, string.format("HTTP %s: %s", tostring(response.StatusCode), tostring(response.Body):sub(1, 200))
	end

	local decodedOk, data = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not decodedOk or type(data) ~= "table" then
		return nil, "response is not valid JSON"
	end

	return data
end

local function extractPlaceIds(data)
	local ids = type(data.placeids) == "table" and data.placeids or data
	local main = tonumber(ids.MainPlaceId)
	local battle = tonumber(ids.BattlePlaceId)
	local trade = tonumber(ids.TradePlaceId)

	if not main or not battle or not trade
		or main <= 0 or battle <= 0 or trade <= 0 then
		return nil
	end

	return {
		MainPlaceId = main,
		BattlePlaceId = battle,
		TradePlaceId = trade,
	}
end

function PlaceIdService:Get()
	if placeCache then
		return placeCache
	end

	for attempt = 1, MAX_ATTEMPTS do
		local ok, dataOrError, requestError = pcall(requestJson, PLACE_PATH)
		if ok and type(dataOrError) == "table" then
			local ids = extractPlaceIds(dataOrError)
			if ids then
				placeCache = ids
				print(string.format(
					"[PlaceIdService] Loaded place IDs: Main=%d Battle=%d Trade=%d",
					ids.MainPlaceId,
					ids.BattlePlaceId,
					ids.TradePlaceId
				))
				return placeCache
			end
			warn("[PlaceIdService] placeids.json is missing valid MainPlaceId/BattlePlaceId/TradePlaceId fields.")
		elseif not ok then
			warn("[PlaceIdService] Place ID request failed: " .. tostring(ok and requestError or dataOrError))
		else
			warn("[PlaceIdService] Place ID request failed: " .. tostring(ok and requestError or dataOrError))
		end

		if attempt < MAX_ATTEMPTS then
			task.wait(math.min(attempt * 2, 6))
		end
	end

	warn("[PlaceIdService] Using last-known fallback place IDs.")
	placeCache = FALLBACK_PLACES
	return placeCache
end

local function validateProductTree(value, path)
	if type(value) == "table" then
		for key, child in pairs(value) do
			if type(key) ~= "string" and type(key) ~= "number" then
				return false, path .. " has an unsupported key"
			end
			local childPath = path .. "." .. tostring(key)
			local ok, reason = validateProductTree(child, childPath)
			if not ok then
				return false, reason
			end
		end
		return true
	end

	local id = tonumber(value)
	if not id or id <= 0 or id % 1 ~= 0 then
		return false, path .. " is not a positive integer product ID"
	end
	return true
end

function PlaceIdService:GetProductIds()
	if productCache then
		return productCache
	end

	for attempt = 1, PRODUCT_ATTEMPTS do
		local ok, dataOrError, requestError = pcall(requestJson, PRODUCT_PATH)
		if ok and type(dataOrError) == "table" then
			-- The repository ships with a safe template so the file exists before the first sync.
			-- Never apply sequential placeholder IDs (1..N) to the live game.
			if dataOrError._template == true then
				warn("[PlaceIdService] productids.json is still a template; run the Railway Developer Product sync. Built-in IDs will be kept.")
				return nil
			end

			local ids = dataOrError.productids
			if type(ids) ~= "table" then
				warn("[PlaceIdService] productids.json has no productids table; keeping built-in IDs.")
				return nil
			end

			local stampedUniverseId = tonumber(dataOrError.universeId)
			if stampedUniverseId then
				if game.GameId <= 0 or stampedUniverseId ~= game.GameId then
					warn(string.format(
						"[PlaceIdService] Ignoring productids.json for universe %s; this server is universe %s. Built-in IDs will be kept.",
						tostring(stampedUniverseId),
						tostring(game.GameId)
					))
					return nil
				end
			else
				warn("[PlaceIdService] productids.json has no universeId stamp; refusing to apply an unverified mapping.")
				return nil
			end

			local valid, reason = validateProductTree(ids, "productids")
			if not valid then
				warn("[PlaceIdService] Invalid product ID mapping: " .. tostring(reason))
				return nil
			end

			productCache = ids
			print(string.format(
				"[PlaceIdService] Loaded developer product mapping for universe %s.",
				tostring(stampedUniverseId)
			))
			return productCache
		else
			local errorMessage = tostring(ok and requestError or dataOrError)
			warn("[PlaceIdService] Product ID request failed: " .. errorMessage)
			-- productids.json may not exist until the first successful Railway sync.
			-- Don't delay Assets initialization by retrying a definite 404.
			if string.find(errorMessage, "HTTP 404", 1, true) then
				break
			end
		end

		if attempt < PRODUCT_ATTEMPTS then
			task.wait(attempt * 2)
		end
	end

	warn("[PlaceIdService] No valid productids.json was loaded; built-in product IDs will remain active.")
	return nil
end

function PlaceIdService:ClearCache()
	placeCache = nil
	productCache = nil
end

return PlaceIdService
