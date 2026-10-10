PATCH: SHOW GITHUB PLACE-ID EXPORT SETTINGS

Replace server/services/configStore.js with the included file, commit/push the change, and redeploy Railway.

Why: older persistent /data/config.json files may have no placeIds.git object. The dashboard previously hid the GitHub fields unless that object already existed. This patch renders those fields with safe defaults so you can edit/save them in the public dashboard.

After redeploy, open Config -> Place IDs export and verify:
- Git export enabled: true
- GitHub owner: z1onkurt999-star
- GitHub repo: PlaceIdsRepo
- GitHub branch: main
- GitHub file path: placeids.json
- Fail upload if GitHub place-ID export fails: keep false until one push succeeds, then set true if desired

In Railway Variables, set PLACEIDS_GITHUB_TOKEN to a fine-grained token with Contents: Read and write for PlaceIdsRepo. Do not put the token in the config or public dashboard.

"Per-place RBXL paths" is unrelated. It only maps each target place to a source .rbxl file path, e.g. {"Main":"/data/game.rbxl","Battle":"/data/game.rbxl","Trade":"/data/game.rbxl"}.
