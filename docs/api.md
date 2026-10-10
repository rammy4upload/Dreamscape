# HTTP API

Base URL: `https://<your-domain>` (e.g. `autoreuploader-production.up.railway.app`)

## Public

| Route | Description |
|-------|-------------|
| `GET /health` | Railway liveness/readiness signal; does not expose secrets |
| `GET /ready` | Application readiness including deployment checks and Roblox health |
| `GET /api/integration/manifest` | Luau download links + endpoints |
| `GET /api/integration/luau/:file` | ProductBridge Luau (`baseUrl` filled) |

## Game (ProductBridge + codes)

| Route | Auth | Description |
|-------|------|-------------|
| `POST /api/products/resolve` | `Authorization: Bearer <API_KEY>` | Resolve/create t-shirt for player |
| `GET /api/codes/codeslist` | `?key=<API_KEY>` | Promo codes Lua source |
| `GET /api/placeids` | Bearer `<API_KEY>` | placeids.json |

## Dashboard (password required)

| Route | Description |
|-------|-------------|
| `GET /` | Web UI |
| `WS /ws` | Live console, prompts, task logs |
| `POST /api/dashboard/run` | Start CLI task |
| `GET /api/dashboard/integration/luau/:file` | Protected Luau download with secrets kept out of the response |
| `GET /api/health` | Protected application health snapshot |
| `PUT /api/dashboard/config` | Save config fields |

## ProductBridge resolve body

```json
{
  "userId": 123456789,
  "productKey": "CandyPurchase",
  "displayName": "Candy Purchase",
  "priceRobux": 125
}
```

Response includes `assetId` for `MarketplaceService:PromptPurchase`.
