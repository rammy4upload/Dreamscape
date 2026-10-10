# Pokemon Brick Bronze | BOT AutoReuploader

Roblox experience automation for **Monster Brick Bronze** copies: RBXL publish, permissions, health monitoring, Discord status, promo codes, and **ProductBridge** (dynamic t-shirt purchases).

**Documentation:** [docs/README.md](./docs/README.md)

| Quick start | |
|-------------|---|
| **Production** | [Railway deploy](./docs/RAILWAY.md) |
| **Windows local** | Run `INSTALL.bat` → `LAUNCH.bat` — [details](./docs/local-windows.md) |
| **PBB game wiring** | [ProductBridge guide](./docs/product-bridge.md) |

```bash
npm install
npm start          # dashboard + APIs (port 3000)
npm run cli        # terminal upload (--reupload default)
autoreuploader --help
```

License: ISC


## Group-owned Roblox experiences

The uploader supports group-owned experiences without requiring `isGroup` to be pre-set correctly. Before the normal/configure pipelines run, it reads the target universe metadata from Roblox. If Roblox reports the universe creator as a group, the run automatically switches to group credential mode and records the detected `groupId`.

For an existing group deployment, the preferred fields are:

```json
{
  "accountPool": {
    "primary": {
      "isGroup": true,
      "groupId": 123456,
      "groupOwnerCookie": "<YOUR_ROBLOSECURITY_COOKIE>",
      "groupApiKey": "<YOUR_GROUP_OPEN_CLOUD_API_KEY>"
    }
  }
}
```

For backward compatibility, an existing deployment that stores the group Open Cloud key in the generic `apiKey` field is accepted when group mode is detected.

The generic universe-permissions endpoint is not treated as authoritative for group ownership. When Roblox reports a universe is group-owned and group credentials are present, the uploader proceeds to the actual write operations; those Roblox write calls remain the final authorization check.
