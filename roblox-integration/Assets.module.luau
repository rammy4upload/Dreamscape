Can you add a automatic make developer peroducts  and replace the ids in here
local repStorage = game:GetService("ReplicatedStorage")
local storage = game:GetService("ServerStorage")

local assetsInit = repStorage:WaitForChild("AssetsInit")
assetsInit = require(assetsInit)

repeat
	task.wait()
until assetsInit.INITIALIZED

local COLOSSEUM_ID = assetsInit.RTD.Battle
local RESORT_ID = assetsInit.RTD.Trade

local assets = {}

local Audios = require(game.ReplicatedStorage.AudioManager)

assets.musicId = {
	ContinueScreen = Audios.ContinueScreen,
}

assets.placeId = {
	Main = assetsInit.RTD.Main,
	Battle = assetsInit.RTD.Battle,
	Trade = assetsInit.RTD.Trade,
}

assets.animationId = {

	-- Pokemons Animations
	absolIdle = 123211746581577,
	absolRun = 104961180467125,
	absolSniff = 89774959695339,
	ArticunoIdle = 70533387991997,
	BlazikenIdle = 70498397400421,
	BlazikenWalk = 87395236242834,	
	ChesnaughtIdle = 138393405845155,
	ChesnaughtWalk = 87395236242834,
	CinderaceIdle = 130266419978210,
	CinderaceWalk = 87395236242834,
	CharizardIdle = 100290302700850,
	CharizardWalk = 87395236242834,
	CobalionIdle = 135672168491488,
	CresseliaIdle = 102100774319948,
	CresseliaRoar = 111353580517725,
	cypressToss = 132500773060708,
	DarkraiIdle = 92591069319881,
	DarkraiRoar = 119851247247281,
	DecidueyeIdle = 99182161874284,
	DecidueyeWalk = 87395236242834,
	DelphoxIdle = 83855294070546,
	DelphoxWalk = 129956913037506,
	dialgaFall = 138920372106869,
	dialgaHover = 124544919473871,
	dialgaIdle = 132269002013544,
	dialgaIdleP = 140356144230938,
	dialgaLand = 137627108671471,
	dialgaRoar = 96536274907102,
	dialgaRoarAir = 71336517276563,
	dialgaRoarGround = 118357482732757,
	dialgaWalkz = 108685419947520,
	ElectivireIdle = 78948339200029,
	ElectivireWalk = 87395236242834,
	EmboarIdle = 93090904585960,
	EmboarWalk = 12345,
	EmpoleonIdle = 72054829376285,
	EmpoleonWalk = 87395236242834,
	EnamorusIdle = 73040188658086,
	enteiRun = 76096420519471,
	raikouRun = 84834690560715,
	suicuneRun = 113939664134924,
	FeraligatrIdle = 88714663666125,
	FeraligatrWalk = 87395236242834,
	Groudon = 18541126871,
	heatranIdle = 91571576964795,
	heatranRoar = 128904404576179,
	HoOhAttack = 116774573410596,
	hoopaAttack = 95214818124959,
	hoopaIdle = 74335905909515,
	hoopaIdle2 = 85156556262885,
	hoopaIdleSlow = 121719434181195,
	IncineroarIdle = 105700002908649,
	IncineroarWalk = 87395236242834,
	InfernapeIdle = 121152641525581,
	InfernapeWalk = 87395236242834,
	InteleonIdle = 77002111172924,
	InteleonWalk = 87395236242834,
	KeldeoIdle = 106768345791093,
	KokoFly = 132388939084769,
	KokoIdle = 84251919588913,
	Kyogre = 18541130785,
	KyogreAttack = 99642217485238,
	KyogreCry = 122343811748206,
	KyogreIdle = 100970456029443,
	Kyurem = 18541078799,
	KyuremBlack = 18541100024,
	KyuremWhite = 18541093988,
	LaprasIdle = 120414299751197,
	Magearna = 129970219338156,
	MeganiumIdle = 117311988647361,
	MeganiumWalk = 87395236242834,
	MeowscaradaIdle = 132465760598191,
	MeowscaradaWalk = 87395236242834,
	MoltresIdle = 125228346370425,
	palkiaFall = 101013839233666,
	palkiaHover = 139870370483879,
	palkiaIdle = 129524899820744,
	palkiaIdleP = 124546339600278,
	palkiaLand = 124582488105505,
	palkiaRoar = 98879188221161,
	palkiaRoarAir = 84460391765509,
	palkiaRoarGround = 95347502334656,
	palkiaWalkz = 89900071656991,
	QuaquavalIdle = 136817063820464,
	QuaquavalWalk = 87395236242834,
	Rayquaza = 18541116968,
	RayquazaIdle = 128450174394806,
	RayquazaWalk = 87395236242834,
	RillaboomIdle = 100211356087094,
	RillaboomWalk = 87395236242834,
	SamurottIdle = 111233957162455,
	SamurottWalk = 87395236242834,
	SceptileIdle = 129469915965897,
	SceptileWalk = 87395236242834,
	SerperiorIdle = 100016610065136,
	SerperiorWalk = 87395236242834,
	SkeledirgeIdle = 71375363180832,
	SkeledirgeWalk = 87395236242834,
	SpectrierAttack = 79228447485093,
	SwampertIdle = 121948842201648,
	SwampertWalk = 87395236242834,
	TerrakionIdle = 107294408392003,
	TyphlosionIdle = 125882658853639,
	TyphlosionWalk = 87395236242834,
	VenusaurIdle = 78845265043731,
	VenusaurWalk = 87395236242834,
	VirizionIdle = 84817887863804,
	Xerneas = 80045390047716,
	Yveltal = 127422986633464,
	ZapdosIdle = 106639391172381,

	-- NPCs,And Character
	cmHats = 93597989537260,
	cmJump = 119055797249789,
	h_backward = 109183138674462,
	h_forward = 139094687878642,
	h_hm = 94693230280651,
	h_idle = 131864845529344,
	h_left = 99433156884535,
	h_mount = 93255146240647,
	h_right = 89446203259043,
	h_trick1 = 81003893571590,
	h_trick2 = 137516012724953,
	h_trick3 = 107148986482506,
	IntroSit = 85652026977857,
	IntroSleep = 129173046272464,
	jakeDive = 111266653836286,
	jakeHold = 81781568465493,
	jakeLift = 120086995925329,
	jakePortal = 89144280001431,
	jakeThrow = 115994554760001,
	jhatAction = 120038315518581,
	jhatIdle = 70737038849870,
	NPCBreakDance = 105416526349700,
	NPCDance1 = 103732640009400,
	NPCDance2 = 87262328937157,
	NPCDance3 = 124691794516432,
	NPCIdle = 117895358130735,
	NPCIdleSwim = 120566194627918,
	NPCPoint = 101039118048586,
	NPCSwim = 91851490774721,
	NPCWalk = 82881950454072,
	NPCWave = 109593330997968,
	NurseBow = 128857109656122,
	profChange = 116231544518086,
	profTurn = 138434393641886,
	tessFall = 93730708032604,
	R15_Carry = 93454393835686,
	R15_Dynamax = 114392750563308,
	R15_h_backward = 138468462748015,
	R15_h_forward = 137377762627327,
	R15_h_idle = 130355470982873,
	R15_h_left = 139396116655609,
	R15_h_mount = 95006275065859,
	R15_h_right = 113421776134387,
	R15_h_trick1 = 123236361915670,
	R15_h_trick2 = 80995293729543,
	R15_h_trick3 = 70726851983407,
	R15_Idle = 119343339657488,
	R15_IntroSleep = 81170586963813,
	R15_IntroTossClock = 121880891028290,
	R15_IntroWake = 132041556110345,
	R15_RodCast = 113054232360360,
	R15_RodIdle = 94647947276177,
	R15_RodReel = 119399774876851,
	R15_Run = 93517632866927,
	R15_Sit = 136570418051590,
	R15_Surf = 71004068734777,
	R15_Sushi = 72961323801631,
	R15_ThrowBall = 118925973555640,
	R15_ZMove = 98581058771322,
	Carry = 101266682106868,
	Run = 80579771314302,
	Sit = 115820654448173,
	Surf = 120092458005100,
	Swim = 113155954993314,
	Dynamax = 111173178017871,
	EatSushi = 134090087942345,
	FlipSign = 110347182566799,
	ZMove = 74554774019648,
	RodCast = 78333111144478,
	RodIdle = 96335432590437,
	RodReel = 96662808828191,
	ThrowBall = 136335690464309,
}
assets.productId = {
	Starter = 1821737304,               --// 15 R$
	TenBP = 1821994564,                 --// 10 R$
	FiftyBP = 1821994648,               --// 30 R$
	TwoHundredBP = 1821994733,          --// 75 R$
	TwoHundredAndFiftyBP = 3713416812,                --// 80 R$
	FiveHundredBP = 3713416893,               --// 130 R$
	OneThousandBP = 3713416926,               --// 200 R$
	TwoThousandBP = 1821994890,         --// 200 R$
	UMV1 = 1821994986,                  --// 5 R$
	UMV3 = 1821995095,                  --// 10 R$
	UMV6 = 1821995194,                  --// 15 R$
	_10kP = 1821995438,                 --// 10 R$
	_50kP = 1821995674,                 --// 40 R$
	_100kP = 1821995801,                --// 75 R$
	_200kP = 1821995926,                --// 120 R$
	PBSpins1 = 1821996104,               --// 5 R$
	PBSpins5 = 1821996185,               --// 20 R$
	PBSpins10 = 1821996286,              --// 30 R$
	AshGreninja = 1821996524,
	DracoElectivire = 3295492297,
	LugiaShadow = 3536912009,
	HoohDarkice = 3536911854,
	LucarioThief = 3536911555,            --// 75 R$
	Hoverboard = 1821996685,              --// 10 R$
	MasterBall = 1821996621,              --// 10 R$
	MewtwoniteShadowX = 3564707678,
	MewtwoniteShadowY = 3564707742,
	LottoTicket = 1821996788,             --// 30 R$
	TixPurchase = 1821996868,             --// 125 R$
	ShadowMewtwo = 3563562612,
	BasicRoulette = 1821997876,      --// 10 R$
	BronzeRoulette = 1821998020,     --// 25 R$
	SilverRoulette = 1821998155,     --// 50 R$
	GoldRoulette = 1821998252,       --// 75 R$
	DiamondRoulette = 1821998363,    --// 125 R$
	PlatinumRoulette = 2679032862,   --// 175 R$
	ShinyRoulette = 2680005309,      --// 100 R$
	SuperShinyRoulette = 2679033479, --// 350 R$
	["Random-Shiny-6x31"] = 676767,--// 399 R$
	["Random-6x31"] = 676767,    --// 150 R$
	["Random-Shiny"] = 676767,   --// 100 R$
	["Cinderace-Pirate"] = 67676767,--// 100 R$
	["Xerneas-Galaxy"] = 67676767, --// 500 R$
	["Shadow-Lugia"] = 676767,   --// 500 R$
	["Mewtwo-Shadow"] = 676767,  --// 500 R$
	["Lunala-H"] = 67676767,       --// 500 R$
	["Shinifier"] = 67676767,      --// 750 R$
	["SilverBottleCap"] = 67676767,--// 400 R$
	["GoldBottleCap"] = 67676767,  --// 1500 R$
	["Necrozma-Dialga"] = 67676767,--// 1000 R$		
	["Necrozma-Yveltal"] = 67676767,--// 1000 R$
	["Necrozma-Zekrom"] = 67676767,--// 1000 R$
	["Necrozma-Palkia"] = 67676767,--// 1000 R$
	["Necrozma-Groudon"] = 67676767,--// 1000 R$
	["Necrozma-Kyogre"] = 67676767,--// 1000 R$
	["Necrozma-Zygarde"] = 67676767,--// 1000 R$
	["Necrozma-Rayquaza"] = 67676767,--// 1000 R$
	["Necrozma-HoOh"] = 67676767,--// 1000 R$
	["Necrozma-Giratina"] = 67676767,--// 1000 R$
	["Necrozma-Xerneas"] = 67676767,--// 1000 R$
	["Necrozma-Reshiram"] = 67676767,--// 1000 R$
	["Necrozma-Lugia"] = 67676767,--// 1000 R$
	["Ho-Oh-Dark"] = 676767, --//450

	RoPowers = {
		{1822000015, 1822000137},       --// 15 R$, 20 R$ (XP) 1-2
		{1822000305, 1822000419},       --// 10 R$, 15 R$ (Hatching) 3-4
		{1822000821, 1822001010},       --// 20 R$, 35 R$ (Pokedollars) 5-6
		{1822001143, 1822001232},      --// 10 R$, 15 R$ (EVs) 7-8
		{1822001378},                   --// 30 R$ (Shiny Boost) 9
		{},                             --// 0  R$ (DO NOT USE) 10
		{1822001470},                 --// 45 R$ (Legendaries) 11
	},
	QuestRerolls = {
		x1  = 3716457274,
		x3  = 3716459456,
		x10 = 3716459552,
	},
}
assets.passId = {
	ExpShare = 1,
	MoreBoxes = 1,
	ShinyCharm = 1,
	AbilityCharm = 1,
	OvalCharm = 1,
	StatViewer = 1,
	RoamingCharm = 1,
	ThreeStamps = 1,
	PondPass = 1,
	evEditor = 1240063957,
	hoverboards = 1338663499,
	trainerbg   = 1340829029,
	genecapsule = 1650076172,
	naturereshaper = 1728417133
}
assets.productIds = {
	PBSpins99 = 1,   
}

assets.badgeId = {
	Gym1 = 313617167,
	Gym2 = 317830251,
	Gym3 = 338423949,
	Gym4 = 512924091,
	Gym5 = 620490478,
	Gym6 = 668968355,
	DexCompletion = {
		{100, 687781576}, 
		{250, 687782030}, 
		{400, 687782269},
		{550, 688159425},
	}
}
assets.badgeImageId = {
	6607886258,
	6607887174,
	6607888513,
	6607889606,
	6607890607,
	6607891487,
	2566476879,
	6255334285,
	530930077
}

if game.CreatorId == 1 then
	-- tbradm Place / Animation / Dev Product / Game Pass IDs (Test game)
	assets.placeId = {
		Main = 17116863447,
		Battle = 17117283520,
		Trade = 17117279245,
	}
	assets.animationId = {
	}
	assets.productId = {
		Regirock = 1822227356, -- TESTING THIS
		Starter = 1804999200,
		FiftyBP = 1804999210,
		TwoHundredAndFiftyBP = 1804999222,
		FiveHundredBP = 1804999237,
		OneThousandBP = 1804999254,
		UMV1 = 1804999270,
		UMV3 = 1804999292,
		UMV6 = 1804999304,
		_10kP = 1804999316,
		_50kP = 1804999328,
		_100kP = 1804999342,
		_200kP = 1804999355,
		PBSpins1 = 1804999371,
		PBSpins5 = 1804999389,
		PBSpins10 = 1804999403,
		AshGreninja = 1804999414,
		Hoverboard = 1804999427,
		MasterBall = 1804999440,
		LottoTicket = 1804999448,
		BuyTix = 1804999459,
		RouletteSpinBasic = 1804999466,
		RouletteSpinBronze = 1804999478,
		RouletteSpinSilver = 1804999490,
		RouletteSpinGold = 1804999518,
		RouletteSpinDiamond = 1804999530,

		RoPowers = {
			{1804999544, 1804999560},       
			{1804999577, 1804999596},       
			{1804999607, 1804999619},       
			{1804999638, 1804999645},       
			{1804999657},                  
			{},                             
			{1804999666}                    
		},
	}
	assets.passId = {
		ExpShare = 311450760,
		MoreBoxes = 343320198,
		ShinyCharm = 385726501,
		ThreeStamps = 678769823,
		-- below are not test place passes
		AbilityCharm = 383208830,
		OvalCharm = 460812378,
		StatViewer = 383208089,
		RoamingCharm = 460812984,
	}
end



-- Apply server-loaded IDs only after the test-game override above. This way a
-- mapping for another universe cannot override the test product table.
local function overlay(target, source)
	for key, value in pairs(source) do
		if type(value) == "table" and type(target[key]) == "table" then
			overlay(target[key], value)
		else
			target[key] = value
		end
	end
end

if type(assetsInit.ProductIds) == "table" then
	overlay(assets.productId, assetsInit.ProductIds)
end


return assets
