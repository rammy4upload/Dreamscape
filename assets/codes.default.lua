return {
	{
		["Name"] = "HmSorry",
		["Date"] = 999999999999,
		["Limit"] = false,
		["Rewards"] = "3 Great Balls, 2 Super Potions",
		["Function"] = function(self)
			self:addBagItems{id = "greatball", quantity = 3}
			self:addBagItems{id = "superpotion", quantity = 2}

			return "Code Successfully Redeemed!"
		end
	},
	{
		["Name"] = "SORRRYYYY",
		["Date"] = 999999999999,
		["Limit"] = false,
		["Rewards"] = "5 Ultra Balls, 5 Potions, 2 Rare Candies, 100 Tix",
		["Function"] = function(self)
			self:addBagItems{id = "ultraball", quantity = 5}
			self:addBagItems{id = "potion", quantity = 5}
			self:addBagItems{id = "rarecandy", quantity = 2}
			self:addTix(100)

			return "Code Successfully Redeemed!"
		end
	},
	{
		["Name"] = "SORRYGUYS",
		["Date"] = 999999999999,
		["Limit"] = false,
		["Rewards"] = "5 Master Balls, 2 Max Elixirs, 10 Max Potions, 10 Revives, 10 Potions, 250 Tix, 10 BP, 100,000 Cash",
		["Function"] = function(self)
			self:addBagItems{id = "masterball", quantity = 5}
			self:addBagItems{id = "maxelixir", quantity = 2}
			self:addBagItems{id = "maxpotion", quantity = 10}
			self:addBagItems{id = "revive", quantity = 10}
			self:addBagItems{id = "potion", quantity = 10}
			self:addTix(250)
			self:addBP(10)
			self:addMoney(100000)

			return "Code Successfully Redeemed!"
		end
	},
	{
		["Name"] = "ROF",
		["Date"] = 999999999999,
		["Limit"] = false,
		["Rewards"] = "10 Ultra Balls, 1 Master Ball",
		["Function"] = function(self)
			self:addBagItems{id = "ultraball", quantity = 10}
			self:addBagItems{id = "masterball", quantity = 1}

			return "Code Successfully Redeemed!"
		end
	},
	{
		["Name"] = "EarlyGame",
		["Date"] = 999999999999,
		["Limit"] = false,
		["Rewards"] = "20 Poke Balls, 10 Super Potions, 10 Revives, 10 Full Heals, 10 UMV Batteries, 1,000 Tix, 100 BP, 20,000 Cash",
		["Function"] = function(self)
			if self.badges[1] then
				self:addBagItems{id = "pokeball", quantity = 20}
				self:addBagItems{id = "superpotion", quantity = 10}
				self:addBagItems{id = "revive", quantity = 10}
				self:addBagItems{id = "fullheal", quantity = 10}
				self:addBagItems{id = "umvbattery", quantity = 10}
				self:addTix(1000)
				self:addBP(100)
				self:addMoney(20000)

				return "Code Successfully Redeemed!"
			else
				return "You must have the Arc Badge before redeeming this code.", true
			end
		end
	},
	{
		["Name"] = "MidGame",
		["Date"] = 999999999999,
		["Limit"] = false,
		["Rewards"] = "10 Quick Balls, 10 Hyper Potions, 10 Revives, 10 Full Heals, 1,000 Tix, 100 BP, 30,000 Cash",
		["Function"] = function(self)
			if self.badges[4] then
				self:addBagItems{id = "quickball", quantity = 10}
				self:addBagItems{id = "hyperpotion", quantity = 10}
				self:addBagItems{id = "revive", quantity = 10}
				self:addBagItems{id = "fullheal", quantity = 10}
				self:addTix(1000)
				self:addBP(100)
				self:addMoney(30000)

				return "Code Successfully Redeemed!"
			else
				return "You must have the Soaring Badge before redeeming this code.", true
			end
		end
	},
	{
		["Name"] = "EndGame",
		["Date"] = 999999999999,
		["Limit"] = false,
		["Rewards"] = "10 UMV Batteries, 1 Macho Brace, 1 Ability Capsule, 1 Ability Patch, 2,000 Tix, 200 BP, 100,000 Cash",
		["Function"] = function(self)
			if self.badges[8] then
				self:addBagItems{id = "umvbattery", quantity = 10}
				self:addBagItems{id = "machobrace", quantity = 1}
				self:addBagItems{id = "abilitycapsule", quantity = 1}
				self:addBagItems{id = "abilitypatch", quantity = 1}
				self:addTix(2000)
				self:addBP(200)
				self:addMoney(100000)

				return "Code Successfully Redeemed!"
			else
				return "You must have the Haunted Badge before redeeming this code.", true
			end
		end
	},
	{
		["Name"] = "RandomPokemon",
		["Date"] = 999999999999,
		["Limit"] = false,
		["Rewards"] = "1 Random Pokemon, 5 Ultra Balls, 5,000 Cash",
		["Function"] = function(self)
			if self.badges[1] then
				local num = math.random(1, 898)

				self:addBagItems{id = "ultraball", quantity = 5}
				self:addMoney(5000)

				self:PC_sendToStore(self:newPokemon({
					num = num,
					level = 10,
					ot = 237253,
					ivs = {
						math.random(20, 31),
						math.random(20, 31),
						math.random(20, 31),
						math.random(20, 31),
						math.random(20, 31),
						math.random(20, 31)
					},
					shiny = math.random(1, 100) == 1,
					untradable = false
				}))

				return "Code Successfully Redeemed!"
			else
				return "You must have the Arc Badge before redeeming this code.", true
			end
		end
	},
	{
		["Name"] = "RandomItems",
		["Date"] = 999999999999,
		["Limit"] = false,
		["Rewards"] = "3 Random Item Types, Random Quantities, 1,000 Tix",
		["Function"] = function(self)
			if self.badges[1] then
				local itemPool = {
					"potion",
					"superpotion",
					"hyperpotion",
					"revive",
					"fullheal",
					"greatball",
					"ultraball",
					"quickball",
					"rarecandy",
					"luckyegg",
					"umvbattery"
				}

				local chosen = {}

				while #chosen < 3 do
					local item = itemPool[math.random(1, #itemPool)]

					if not table.find(chosen, item) then
						table.insert(chosen, item)
					end
				end

				for _, item in ipairs(chosen) do
					self:addBagItems{
						id = item,
						quantity = math.random(1, 5)
					}
				end

				self:addTix(1000)

				return "Code Successfully Redeemed!"
			else
				return "You must have the Arc Badge before redeeming this code.", true
			end
		end
	}
}
