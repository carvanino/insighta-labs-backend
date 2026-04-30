# Insighta Labs+ — Backend

Secure, multi-interface Profile Intelligence API. Built on top of Stage 2 with authentication, role-based access control, token management, and a CSV export.

---

## System Architecture

```
┌─────────────────────────────────────────────────┐
│                   Clients                        │
│        CLI Tool          Web Portal              │
└────────────┬─────────────────┬───────────────────┘
             │                 │
             ▼                 ▼
┌─────────────────────────────────────────────────┐
│              Insighta Labs+ Backend              │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │  /auth   │  │  /api    │  │  Middleware   │  │
│  │  router  │  │ profiles │  │  authenticate │  │
│  └──────────┘  └──────────┘  │  authorize    │  │
│                               │  apiVersion   │  │
│  ┌─────────────────────────┐  │  rateLimiter  │  │
│  │     GitHub OAuth        │  │  logger       │  │
│  │  (PKCE for CLI flow)    │  └───────────────┘  │
│  └─────────────────────────┘                     │
│                                                  │
│  ┌─────────────────────────────────────────────┐ │
│  │             PostgreSQL                      │ │
│  │  profiles · users · refresh_tokens         │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

---

## Prerequisites

- Node.js 18+
- PostgreSQL 14+
- A GitHub OAuth App ([create one here](https://github.com/settings/developers))

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy env file and fill in values
cp .env.example .env

# 3. Generate secrets
openssl rand -hex 64   # ACCESS_TOKEN_SECRET
openssl rand -hex 64   # REFRESH_TOKEN_SECRET
openssl rand -hex 32   # COOKIE_SECRET

# 4. Start the server
npm run dev
```

The server will initialise all database tables on startup via `initDB()`.

---

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3004) |
| `DATABASE_URL` | PostgreSQL connection string |
| `DB_SSL` | Set to `true` for hosted DBs |
| `GENDERIZE_URL` | `https://api.genderize.io` |
| `AGIFY_URL` | `https://api.agify.io` |
| `NATIONALIZE_URL` | `https://api.nationalize.io` |
| `GITHUB_CLIENT_ID` | From your GitHub OAuth App |
| `GITHUB_CLIENT_SECRET` | From your GitHub OAuth App |
| `GITHUB_CALLBACK_URL` | Must match GitHub app settings |
| `ACCESS_TOKEN_SECRET` | JWT signing secret |
| `REFRESH_TOKEN_SECRET` | Refresh token signing secret |
| `ACCESS_TOKEN_EXPIRY` | In seconds — TRD requires `180` |
| `REFRESH_TOKEN_EXPIRY` | In seconds — TRD requires `300` |
| `WEB_PORTAL_URL` | Origin for CORS on the web portal |
| `COOKIE_SECRET` | Cookie signing secret |

---

## Authentication Flow

### Overview
All access to `/api/*` endpoints requires a valid JWT access token. Tokens are issued after GitHub OAuth login and sent on every request as `Authorization: Bearer <access_token>` (CLI) or as an HTTP-only cookie (web portal).

### Web Portal Flow

```
Browser → GET /auth/github
       ← 302 redirect to GitHub OAuth page

GitHub → GET /auth/github/callback?code=...&state=...
Backend validates state → exchanges code for GitHub token
       → fetches GitHub user → upserts user in DB
       → issues access token + refresh token
       → sets HTTP-only cookies
       ← redirects to /dashboard
```

### CLI Flow (Backend-Routed)

```
CLI starts a local HTTP server on port 4242
CLI opens → ${BACKEND_URL}/auth/github?cli_port=4242

Backend encodes cli_port into state, redirects to GitHub OAuth
GitHub → GET /auth/github/callback?code=...&state=...

Backend exchanges code with GitHub, creates/updates user, issues tokens
Backend decodes cli_port from state
Backend redirects → http://localhost:4242/callback?access_token=...&refresh_token=...

CLI receives tokens, saves to ~/.insighta/credentials.json
CLI prints: Logged in as @username
```

---

## Token Lifecycle

| Token | Expiry | Storage | Purpose |
|---|---|---|---|
| Access token | 3 minutes | CLI file / HTTP-only cookie | Authenticates API requests |
| Refresh token | 5 minutes | PostgreSQL `refresh_tokens` table | Issues new token pairs |

**Token Flow:**
1. Login → receive `access_token` (3 min) + `refresh_token` (5 min)
2. Use `access_token` on every `/api/*` request via `Authorization: Bearer` header
3. When `access_token` expires → call `POST /auth/refresh` with `refresh_token` to get a new pair
4. Old refresh token is immediately invalidated (rotation) — new pair issued
5. On logout → `POST /auth/logout` deletes the refresh token from DB

**Rotation:** Every `POST /auth/refresh` invalidates the old refresh token immediately and issues a new pair.

**Revocation:** `POST /auth/logout` deletes the refresh token from the DB. The access token expires naturally — no server-side blacklist.

**is_active check:** On every authenticated request, the backend queries the DB to confirm `is_active = true`. Deactivated users are blocked immediately.

---

## Role-Based Access Control (RBAC)

Two roles exist: `admin` and `analyst`. Default on signup is `analyst`.

| Role | Permissions |
|---|---|
| `admin` | Full access — create profiles, delete profiles, read, search, export |
| `analyst` | Read-only — list, get by id, search, export |

Role enforcement is handled by two middleware functions in sequence on every `/api/*` request:

1. `authenticate` — verifies JWT signature, decodes payload, checks `is_active = true` in DB, attaches `req.user`
2. `authorize(role)` — compares `req.user.role` against the required role, returns `403` if mismatch

```js
router.post("/",      authorize("admin"), handler) // admin only
router.delete("/:id", authorize("admin"), handler) // admin only
router.get("/",       handler)                     // any authenticated user
```

---

## CLI Integration

The CLI (`insighta`) is globally installable and communicates exclusively with this backend.

```bash
npm install -g insighta-cli

insighta login                               # GitHub OAuth → tokens stored at ~/.insighta/credentials.json
insighta whoami                              # show current user
insighta logout                              # invalidate session

insighta profiles list                       # GET /api/profiles
insighta profiles list --gender male         # with filters
insighta profiles list --page 2 --limit 20   # with pagination
insighta profiles get <id>                   # GET /api/profiles/:id
insighta profiles search "adults from nigeria" # GET /api/profiles/search
insighta profiles create --name "Ada Lovelace" # POST /api/profiles (admin only)
insighta profiles export --format csv        # GET /api/profiles/export
```

The CLI auto-refreshes expired access tokens silently using the stored refresh token. If refresh fails, credentials are cleared and the user is prompted to run `insighta login` again.

---

## Web Portal Integration

The web portal communicates with this backend using HTTP-only cookies. Tokens are never accessible via JavaScript.

- **Login:** browser redirects to `GET /auth/github` → GitHub OAuth → backend sets HTTP-only cookies → redirects to `/dashboard`
- **API calls:** `withCredentials: true` sends cookies automatically on every request
- **CSRF:** portal fetches a token from `GET /csrf-token` and sends it as `X-CSRF-Token` on every mutating request
- **Token refresh:** on `401`, portal silently calls `POST /auth/refresh` (cookie-based) and retries the original request
- **Logout:** `POST /auth/logout` clears cookies server-side

---

## API Reference

### Auth

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/auth/github` | Redirect to GitHub OAuth |
| `GET` | `/auth/github/callback` | Handle OAuth callback, issue tokens |
| `POST` | `/auth/refresh` | Rotate refresh token, get new pair |
| `POST` | `/auth/logout` | Invalidate refresh token |

**Refresh request:**
```json
{ "refresh_token": "string" }
```

**Refresh response:**
```json
{ "status": "success", "access_token": "string", "refresh_token": "string" }
```

---

### Profiles

All `/api/*` endpoints require:
- `Authorization: Bearer <access_token>`
- `X-API-Version: 1`

| Method | Endpoint | Role | Description |
|---|---|---|---|
| `GET` | `/api/profiles` | any | List profiles with filters, sorting, pagination |
| `GET` | `/api/profiles/:id` | any | Get a single profile |
| `GET` | `/api/profiles/search?q=` | any | Natural language search |
| `GET` | `/api/profiles/export?format=csv` | any | Export filtered profiles as CSV |
| `POST` | `/api/profiles` | admin | Create a new profile |
| `DELETE` | `/api/profiles/:id` | admin | Delete a profile |

**Query parameters (list + export):**

| Param | Type | Example |
|---|---|---|
| `gender` | `male` \| `female` | `?gender=male` |
| `age_group` | `child` \| `teenager` \| `adult` \| `senior` | `?age_group=adult` |
| `country_id` | ISO 3166-1 alpha-2 | `?country_id=NG` |
| `min_age` / `max_age` | number | `?min_age=20&max_age=35` |
| `sort_by` | `age` \| `created_at` \| `gender_probability` | `?sort_by=age` |
| `order` | `asc` \| `desc` | `?order=desc` |
| `page` / `limit` | number (limit max: 50) | `?page=2&limit=20` |

**Paginated response shape:**
```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 2026,
  "total_pages": 203,
  "links": {
    "self": "/api/profiles?page=1&limit=10",
    "next": "/api/profiles?page=2&limit=10",
    "prev": null
  },
  "data": [ ... ]
}
```

---

## Natural Language Search

`GET /api/profiles/search?q=young+males+from+nigeria`

The parser is fully rule-based — no AI or external services involved. It extracts:

- **Gender** — keywords: `male`, `men`, `man`, `female`, `women`, `woman`
- **Age group** — keywords: `children`, `teenagers`, `adults`, `seniors`
- **Age range** — patterns: `above 25`, `under 40`, `between 20 and 30`, `young` (maps to 16–24)
- **Country** — 100+ country names mapped to ISO codes, longest-match first to handle multi-word names (e.g. `south africa` matches before `africa`)

If no recognisable intent is found, returns `{ "status": "error", "message": "Unable to interpret query" }`.

---

## Rate Limiting

| Scope | Limit | Key |
|---|---|---|
| `/auth/*` | 10 requests / minute | IP address |
| `/api/*` | 60 requests / minute | User ID (falls back to IP) |

Returns `429 Too Many Requests` when exceeded.

---

## Request Logging

Every request is logged to stdout:

```
GET /api/profiles 200 12 ms
POST /auth/refresh 200 8 ms
```

Format: `METHOD URL STATUS RESPONSE_TIME`

---

## Project Structure

```
stage-3/
├── server.js              Entry point
├── src/
│   ├── app.js             Express setup, middleware, route mounting
│   ├── utils.js           ApiError, sendError, formatProfile, helpers
│   ├── nlp.js             Rule-based NLP parser
│   ├── db/
│   │   └── index.js       pg pool + initDB (creates all tables)
│   ├── auth/
│   │   ├── router.js      /auth/* routes
│   │   ├── service.js     GitHub OAuth, token issuance, user upsert
│   │   └── pkce.js        PKCE helpers (used by CLI)
│   ├── middleware/
│   │   ├── authenticate.js  JWT verification + is_active check
│   │   ├── authorize.js     Role enforcement factory
│   │   ├── apiVersion.js    X-API-Version header check
│   │   ├── rateLimiter.js   Per-scope rate limiters
│   │   └── logger.js        Morgan request logger
│   └── profiles/
│       ├── router.js      /api/profiles/* routes
│       └── service.js     External APIs, buildQuery, DB operations
└── .env.example
```

---

## Security Notes

- Access tokens are short-lived (3 min) and stateless — verified by signature only
- Refresh tokens are stored in the DB and invalidated on every use (rotation)
- `is_active` is checked on every request via DB — deactivated users are blocked immediately
- State parameter prevents CSRF on the OAuth flow — stored in-memory with a 5-minute TTL
- All error responses follow a consistent `{ "status": "error", "message": "..." }` shape — no stack traces or internal details are leaked
