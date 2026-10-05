# HTTP API

Base URL: `https://<your-domain>` (e.g. `autoreuploader-production.up.railway.app`)

## Public

| Route | Description |
|-------|-------------|
| `GET /health` | Deploy status, warnings, integration URLs |
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
| `GET /api/dashboard/integration/luau/:file?includeSecrets=1` | Luau with API key filled |
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
