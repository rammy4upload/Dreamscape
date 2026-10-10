AutoReuploader operational patch

This ZIP is a PATCH, not the whole project. Copy the included files over the same relative paths at your repository root, commit/push the changes, and redeploy on Railway.

Files included:
- cli/reuploader.js
  * Introspects configured Open Cloud keys and selects one that is actually authorized for the target universe's place publish scope before uploading.
  * Uses a cookie fallback for universe visibility/device settings when neither configured key has Universe -> Write.
  * Respects experience.playableDevices and fixes the old all-devices configuration path.
- src/shared/operationRunner.js
  * Does not turn a thrown publish/configuration error into SUCCESS just because the universe still exists.
- src/shared/placeIdsExport.js
  * Saves local placeids.json and treats remote GitHub/local Git sync failure as a warning by default.
  * Set placeIds.git.required=true only if a remote place-ID export failure must fail the whole operation.
- server/services/configStore.js
  * Exposes questionnaire JSON fields, playable devices, private-server settings, Discord invite, and more Discord channel settings in the dashboard config editor.
- server/services/discordClient.js
  * Makes HTTP 403 Missing Access logs more actionable.
- config.example.json
  * Documents placeIds.git.required=false as the default.

Important after deployment:
1. The current log's alternate key "Place Publisher Copy" is authorized for publishing to universe 10038434034. The group key "Auto Upload Copy Copy Copy" does not include that universe in its universe-places scope, so the uploader should select the alternate key for place uploads.
2. Neither currently inspected key has Universe -> Write. The patch avoids trying Open Cloud settings with those keys and uses the authenticated Creator Dashboard cookie fallback instead. If Roblox still rejects device-setting changes, that is a separate Roblox permission/endpoint limitation and will be reported as a warning.
3. If the live /data/config.json has placeIds.git.required=true, switch it to false in the dashboard if you do not want a GitHub sync error to fail the Roblox upload. Local placeids.json is saved regardless.
4. Questionnaire only runs when enabled=true and valid, truthful questionIds/answers (or answersByQuestionId) are provided. The patch exposes those values in the dashboard but cannot invent Roblox questionnaire answers.
5. Discord HTTP 403 code 50001 means the bot cannot access the configured channel. Confirm the bot is in the intended Discord server, each channel ID is correct, and it has View Channel and Send Messages. For player-count voice-channel renames it also needs Manage Channels. Code cannot grant Discord server permissions automatically.

The patch deliberately does not include config.json, .env, cookies, API keys, or bot tokens.


RBXL SOURCE FIX (added):
- RBXL paths are resolved against the active config directory first (on Railway, often /data), then DATA_DIR, then the app working directory.
- Before uploading, the bot logs the exact source path, byte count, and full SHA-256 for Main/Battle/Trade; the success line repeats sourceSha256.
- Optional experience.rbxlPaths lets you supply an object such as {"Main":"/data/new-game.rbxl","Battle":"/data/new-game.rbxl","Trade":"/data/new-game.rbxl"}; if omitted, experience.rbxlPath is shared.
- A code patch cannot magically update an old .rbxl file. You must place the updated PlaceIdFetch .rbxl on Railway and point experience.rbxlPath (or rbxlPaths) at that file. Check the logged path/hash on the next upload.


PLACE ID SYNC ROOT CAUSE (added):
- The uploaded target places in the latest log (Main=94924486769688, Battle=106563467714705, Trade=90670750620211) do not match the PlaceIdsRepo values you shared (Main=83489293813738, Battle=101608462825327, Trade=110117993068660). A PlaceIdFetch script that reads the stale GitHub file will keep entering the old places.
- The exporter now explicitly warns if placeIds.git.enabled=false instead of silently writing only /data/placeids.json. Successful GitHub export prints the exact new ID mapping.
- In the Railway dashboard config, enable placeIds.git.enabled and set placeIds.git.required=true if this repository is the runtime source of truth. Set githubOwner=z1onkurt999-star, githubRepo=PlaceIdsRepo, githubBranch=main, githubFilePath=placeids.json, and add Railway variable PLACEIDS_GITHUB_TOKEN (or GITHUB_TOKEN) with Contents: Read and Write access. Do not paste the token into chat.
