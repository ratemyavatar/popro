# PoPro: RoPro for Rokori

PoPro runs the RoPro browser extension on [rokori.com](https://www.rokori.com) as a Tampermonkey userscript, backed by your own RoPro-compatible API server.

This repo has two parts:

| Folder | What it is |
| --- | --- |
| `server/` | **PoPro API**, the RoPro-compatible backend you host on your VPS. Node 18+, no dependencies. |
| `userscript/` | **Build tooling** that turns your own copy of the RoPro extension into the Tampermonkey script. It patches RoPro for rokori and points it at your API. |

> RoPro's own code is **not** in this repo, including the built userscript, which contains it. You build the userscript locally from your copy of the RoPro `.crx`.

---

## 1. Host the API on your VPS

You need a domain or subdomain for it, for example `api.yourdomain.com`, served over **HTTPS**. Browsers block a plain-HTTP API from rokori.

### Option A: Docker

```bash
git clone https://github.com/ratemyavatar/popro.git /opt/popro
```

```bash
cd /opt/popro && cp .env.example .env
```

```bash
docker compose up -d --build
```

The API listens on `127.0.0.1:8787`. Put a reverse proxy in front of it for HTTPS (step 2).

### Option B: plain Node + systemd

```bash
sudo useradd --system --home /opt/popro popro
```

```bash
sudo git clone https://github.com/ratemyavatar/popro.git /opt/popro && sudo cp /opt/popro/.env.example /opt/popro/.env
```

```bash
sudo cp /opt/popro/deploy/popro-api.service /etc/systemd/system/ && sudo systemctl enable --now popro-api
```

### 2. HTTPS

**Caddy** gets certificates automatically. Put your domain in `deploy/Caddyfile`, then:

```bash
sudo cp /opt/popro/deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

**nginx:** copy `deploy/nginx.conf` to `/etc/nginx/sites-enabled/` and put your domain in it, then run:

```bash
sudo certbot --nginx -d api.yourdomain.com
```

Check it: `https://api.yourdomain.com/health` should return `{"ok":true,...}`.

### Settings (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | `https://www.rokori.com,https://rokori.com` | Sites allowed to call the API (CORS) |
| `ROKORI_ORIGIN` | `https://www.rokori.com` | Where user, bio and game data is read from |
| `TRUST_PROXY` | `0` | Set `1` behind nginx/Caddy so rate limits see real IPs |
| `RATE_LIMIT_PER_MIN` | `600` | Requests per IP per minute (verification: 20/min) |
| `THEME_CACHE_MINUTES` | `60` | How long RoPro's public theme catalog is kept in memory |
| `DISABLED_FEATURES` | *(empty)* | Comma-separated RoPro features to switch off for everyone |
| `DATA_DIR` | `server/data` | Where the JSON data files live. Back this up. |

Run the tests with `cd server && npm test` (needs internet access to rokori and RoPro).

---

## 3. Build the userscript

On your own computer:

```bash
cd popro/userscript && npm install
```

Unpack your copy of the RoPro extension into `popro/ropro-src` (a `.crx` is a zip with a small header; `unzip` handles it):

```bash
unzip -o RoPro.crx -d ../ropro-src
```

Build it, pointing at **your** API domain:

```bash
node build.js ../ropro-src dist/PoPro.user.js https://api.yourdomain.com
```

Install `dist/PoPro.user.js` in Tampermonkey: Dashboard → Utilities → *Import from file*. The file is about 12 MB because RoPro's images and fonts are inlined.

---

## How it works

**Verification.** In any *Verify RoPro User* box, the server gives you a phrase like `ropro-yourname-maple-otter-42`. You put it in your rokori bio and press **Verify**. The server reads your bio through rokori's public API and issues a private token, which the userscript keeps. After that you can remove the phrase.

**Themes.** RoPro's real, current theme catalog is relayed from RoPro's public API, with no user data sent. The theme images and frames load straight from RoPro's servers, the same as with the real extension. The server stores nothing of RoPro's. If RoPro is unreachable, the theme lists are empty.

**Tier.** Everyone is on RoPro's free tier. Plus/Rex features, the animated themes and all upgrade prompts are hidden. They aren't unlocked.

**Data the server keeps** (JSON files in `DATA_DIR`):
- verification tokens
- saved profile themes
- profile likes (reputation)
- linked Discord names
- last-online time, if visible
- playtime per game
- a cache of public rokori game info
- server invite links
- bug reports and feature requests

### Endpoints

The server speaks RoPro's API paths (`/getProfileTheme.php`, `/getThemesV2.json`, …) with RoPro's headers (`ropro-id`, `ropro-verification`). It adds two of its own:

- `POST /rokori/verify/start {userId}` → `{phrase}`
- `POST /rokori/verify/check {userId}` → `{verified, token}`

### Userscript internals (`userscript/runtime.js`, `userscript/build.js`)

- **Private worlds.** RoPro's content scripts and its MV3 background service worker each run in a private global, so RoPro's jQuery never touches rokori's page.
- **Chrome API shims.** `chrome.runtime`, `storage`, `alarms`, `tabs` and `notifications` run on Tampermonkey's GM APIs.
- **URL rewriting.**
  - `*.roblox.com` maps to `www.rokori.com`, because rokori serves every API path there.
  - `api.ropro.io` maps to your API.
- **RoPro's pages.** `/sandbox`, `/themes` and the settings page are hosted at `/request-error?code=404#ropro=/…`, because rokori redirects unknown paths.
- **Avatar sandbox.** Renders use rokori's own 2D render server and its own 3D viewer component.
- **Theme frames.** Rokori's URL shim would rewrite them, so they're pinned to their real URL.
