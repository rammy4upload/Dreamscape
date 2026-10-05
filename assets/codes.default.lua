return {
	{
		["Name"] = "EarlyGame",
		['Date'] = 999999999999,
		['Limit'] = false,
		['Rewards'] = "20 Pοkеballs, 10 Super Potions, 10 Revives, 10 Full Heals, 10 UMV Batteries, 1,000 Tix, 100 BP, 20,000 Cash",
		["Function"] = function(self)
			if self.badges[1] then
				self:addBagItems{id = 'monstball', quantity = 20}
				self:addBagItems{id = 'superpotion', quantity = 10}
				self:addBagItems{id = 'revive', quantity = 10}
				self:addBagItems{id = 'fullheal', quantity = 10}
				self:addBagItems{id = 'umvbattery', quantity = 10}
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
		['Date'] = 999999999999,
		['Limit'] = false,
		['Rewards'] = "10 Quickballs, 10 Hyper Potions, 10 Revives, 10 Full Heals, 1,000 Tix, 100 BP, 30,000 Cash",
		["Function"] = function(self)
			if self.badges[4] then
				self:addBagItems{id = 'quickball', quantity = 10}
				self:addBagItems{id = 'hyperpotion', quantity = 10}
				self:addBagItems{id = 'revive', quantity = 10}
				self:addBagItems{id = 'fullheal', quantity = 10}
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
		['Date'] = 999999999999,
		['Limit'] = false,
		['Rewards'] = "10 UMV Batteries, 1 Macho Brace, 1 Ability Capsule, 1 Ability Patch, 2,000 Tix, 200 BP, 100,000 Cash",
		["Function"] = function(self)
			if self.badges[8] then
				self:addBagItems{id = 'umvbattery', quantity = 10}
				self:addBagItems{id = 'machobrace', quantity = 1}
				self:addBagItems{id = 'abilitycapsule', quantity = 1}
				self:addBagItems{id = 'abilitypatch', quantity = 1}
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
		["Name"] = "PrimalAwakening",
		['Date'] = 999999999999,
		['Limit'] = false,
		['Rewards'] = "10 Ultra Balls and 1 Master Ball",
		["Function"] = function(self)    
			self:addBagItems{id = 'ultraball', quantity = 10}
			self:addBagItems{id = 'masterball', quantity = 3}

			return "Code Successfully Redeemed!"
		end
	},
	{
		["Name"] = "SorryFolks",
		['Date'] = 999999999999,
		['Limit'] = false,
		['Rewards'] = "25,000 Cash 200 BP, 2000 Tix, 1 Lucky Egg, 1 Master Ball, 1 Random Monster",
		["Function"] = function(self)
			local i = math.random(1,898)
			local shinyMath = math.random(1,3)
			local isShiny = false
			if i == 132 or  i == 144 or i == 145 or i == 146 or i == 150 or i == 151 
				or i == 243 or i == 244 or i == 245 or i == 249 or i == 250 or i == 251
				or i == 377 or i == 378 or i == 379	or i == 380 or i == 381 or i == 382 or i == 383 or i == 384 or i == 385 or i == 386
				or i == 480 or i == 481 or i == 482 or i == 483 or i == 484 or i == 485 or i == 486 or i == 487 or i == 488 or i == 489 or i == 490 or i == 491 or i == 492 or i == 493 or i == 494
				or i == 640 or i == 641 or i == 642 or i == 643 or i == 644 or i == 645 or i == 646 or i == 647 or i == 648 or i == 649
				or i == 716 or i == 717 or i == 718 or i == 719 or i == 720 or i == 721 
				or i == 772 or i == 773 or i == 785 or i == 786 or i == 787 or i == 788 or i == 789 or i == 790 or i == 791 or i == 792 or i == 793 or i == 794 or i == 795 or i == 796 or i == 797 or i == 798 or i == 799 or i == 800 or i == 801 or i == 802 or i == 803 or i == 804 or i == 805 or i == 806 or i == 807 or i == 808 or i == 809
				or i == 888 or i == 889 or i == 890 or i == 891 or i == 892 or i == 893 or i == 894 or i == 895 or i == 896 or i == 897 or i == 898
				or i == 980 or i == 987 or i == 994 or i == 995 or i == 996 or i == 997 or i == 998 or i == 999 or i == 1011 or i == 1014 or i == 1015 or i == 1016 or i == 1017 or i == 1018 or i == 1019 or i == 1020 or i == 1021 or i == 1022
			then i = 872
			end

			if shinyMath == 2 then
				isShiny = true
			end

			self:addMoney(25000)
			self:addTix(2000)
			self:addBP(200)
			self:addBagItems{id = 'luckyegg', quantity = 1}
			self:addBagItems{id = 'masterball', quantity = 1}

			self:PC_sendToStore(self:newMonster({
				num = i,
				level = 10,
				ot = 237253,
				ivs = {math.random(20,31), math.random(20,31), math.random(20,31), math.random(20,31), math.random(20,31),math.random(20,31)},
				shiny = isShiny,
				untradable = false
			}))

			return "Code Successfully Redeemed!"
		end,
	},
	{
		["Name"] = "VeryEpicStaffCode",
		['Date'] = 999999999999,
		['Limit'] = false,
		['GroupLock'] = true,
		['GroupId'] = 445752211,
		['GroupRank'] = 25,
		['Rewards'] = "30,000 Cash, 250 BP, 3 Master Balls, and 1 Random Shiny",
		["Function"] = function(self)
			local randomMath = math.random(1, 100)
			local override = false
			local isLegendary = false
			local i = math.random(1,898)

			if randomMath <= 14 or randomMath >= 85 then
				if randomMath == 1 or randomMath == 8 then
					override = 150 -- Mewtwo
				elseif randomMath == 2 or randomMath == 9 then
					override = 382 -- Kyogre
				elseif randomMath == 3 or randomMath == 10 then
					override = 383 -- Groudon
				elseif randomMath == 4 or randomMath == 11 then
					override = 249 -- Lugia
				elseif randomMath == 5 or randomMath == 12 then
					override = 385 -- Jirachi
				elseif randomMath == 6 or randomMath == 13 then
					override = 244 -- Entei
				elseif randomMath == 7 or randomMath == 14 then
					override = 641 -- Tornadus
				elseif randomMath == 93 or randomMath == 85 then
					override = 642 -- Thundurus
				elseif randomMath == 94 or randomMath == 86 then
					override = 645 -- Landorus
				elseif randomMath == 95 or randomMath == 87 then
					override = 146 -- Moltres
				elseif randomMath == 96 or randomMath == 88 then
					override = 889 -- Zamazenta
				elseif randomMath == 97 or randomMath == 89 then
					override = 145 -- Zapdos
				elseif randomMath == 98 or randomMath == 90 then
					override = 483 -- Dialga
				elseif randomMath == 99 or randomMath == 91 then
					override = 484 -- Palkia
				elseif randomMath == 100 or randomMath == 92 then
					override = 144 -- Articuno
				end
			end

			if override ~= false then
				isLegendary = true
			end

			self:addMoney(30000)
			self:addBP(250)
			self:addBagItems{id = 'masterball', quantity = 3}
			self:PC_sendToStore(self:newMonster({
				num = (isLegendary and override) or i,
				level = 10,
				ot = 237253,
				ivs = {math.random(27,31), math.random(27,31), math.random(27,31), math.random(27,31), math.random(27,31),math.random(27,31)},
				shiny = true,
				untradable = false
			}))

			return "Code Successfully Redeemed!"
		end,
	},
	{
		["Name"] = "MasterBalls",
		['Date'] = 999999999999,
		['Limit'] = false,
		['Rewards'] = "25,000 Cash 200 BP, 1000 Tix, 2 Master Balls",
		["Function"] = function(self)
			local i = math.random(1,898)
			local shinyMath = math.random(1,3)
			local isShiny = false
			if i == 132 or  i == 144 or i == 145 or i == 146 or i == 150 or i == 151 
				or i == 243 or i == 244 or i == 245 or i == 249 or i == 250 or i == 251
				or i == 377 or i == 378 or i == 379	or i == 380 or i == 381 or i == 382 or i == 383 or i == 384 or i == 385 or i == 386
				or i == 480 or i == 481 or i == 482 or i == 483 or i == 484 or i == 485 or i == 486 or i == 487 or i == 488 or i == 489 or i == 490 or i == 491 or i == 492 or i == 493 or i == 494
				or i == 640 or i == 641 or i == 642 or i == 643 or i == 644 or i == 645 or i == 646 or i == 647 or i == 648 or i == 649
				or i == 716 or i == 717 or i == 718 or i == 719 or i == 720 or i == 721 
				or i == 772 or i == 773 or i == 785 or i == 786 or i == 787 or i == 788 or i == 789 or i == 790 or i == 791 or i == 792 or i == 793 or i == 794 or i == 795 or i == 796 or i == 797 or i == 798 or i == 799 or i == 800 or i == 801 or i == 802 or i == 803 or i == 804 or i == 805 or i == 806 or i == 807 or i == 808 or i == 809
				or i == 888 or i == 889 or i == 890 or i == 891 or i == 892 or i == 893 or i == 894 or i == 895 or i == 896 or i == 897 or i == 898
				or i == 980 or i == 987 or i == 994 or i == 995 or i == 996 or i == 997 or i == 998 or i == 999 or i == 1011 or i == 1014 or i == 1015 or i == 1016 or i == 1017 or i == 1018 or i == 1019 or i == 1020 or i == 1021 or i == 1022
			then i = 872
			end

			if shinyMath == 2 then
				isShiny = true
			end

			self:addMoney(25000)
			self:addTix(1000)
			self:addBP(200)
			self:addBagItems{id = 'masterball', quantity = 2}

			self:PC_sendToStore(self:newMonster({
				num = i,
				level = 10,
				ot = 237253,
				ivs = {math.random(20,31), math.random(20,31), math.random(20,31), math.random(20,31), math.random(20,31),math.random(20,31)},
				shiny = isShiny,
				untradable = false
			}))

			return "Code Successfully Redeemed!"
		end,
	},
}
