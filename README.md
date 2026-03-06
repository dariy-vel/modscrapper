# modscrapper

A minimal Vercel serverless API that returns the latest available version of an Android app from [Platinmods](https://platinmods.com).

## Usage

### Search by app name

```
GET /api/version?q=<app name>
```

```
GET /api/version?q=BuzzKill
```

### Use a pre-built Platinmods search URL

If you already have a Platinmods search URL (e.g. copied from the browser), pass it directly:

```
GET /api/version?url=<platinmods search URL>
```

```
GET /api/version?url=https://platinmods.com/search/157784990/?q=BuzzKill&c[title_only]=1&o=date
```

### Response (JSON)

Add `&format=json` to get a machine-readable response instead:

```json
{
  "version": "v30.11.0",
  "thread_url": "https://platinmods.com/threads/buzzkill-notification-manager-v30-11-0-mod-apk-license-check-remove.281862/",
  "all_results": [
    { "version": "v30.11.0", "thread_url": "https://platinmods.com/threads/..." },
    { "version": "v30.9",    "thread_url": "https://platinmods.com/threads/..." }
  ],
  "search_url": "https://platinmods.com/search/157785203/?q=BuzzKill&c[title_only]=1&o=date",
  "source": "platinmods"
}
```

`version` is the top result from a date-ordered search, so it reflects the most recently posted thread — typically the latest available mod version.

### Error responses

| Status | Meaning |
|--------|---------|
| 400 | Missing `q` or `url` parameter |
| 404 | No versioned threads found for the query |
| 502 | Platinmods returned an unexpected response |
| 500 | Internal error |

## Obtainium integration

> **Track-only** — Platinmods requires authentication to download files, so Obtainium will detect version changes but you will need to download the APK manually.

Two source types are supported. The **APKMirror** option is recommended because it also surfaces the release date.

### Option A — APKMirror source (version + release date)

Obtainium's APKMirror source parser fetches `{url}/feed/` and reads an RSS 2.0 feed. A Vercel rewrite handles this automatically.

The URL **must** match APKMirror's expected path pattern (`/apk/<org>/<app>`), so use the `/apk/` prefix with a placeholder org segment:

| Field | Value |
|-------|-------|
| **App source URL** | `https://<your-deployment>/apk/placeholder/<App Name>` |
| **Override source** | APKMirror |
| **Mark as track-only** | ✅ enabled |

Example: `https://<your-deployment>/apk/placeholder/BuzzKill`

Obtainium will fetch `…/apk/placeholder/BuzzKill/feed/`, which returns RSS like:

```xml
<item>
  <title>BuzzKill 30.11.0 by Platinmods</title>
  <pubDate>Thu, 06 Feb 2026 03:04:00 GMT</pubDate>
</item>
```

Version is extracted from the title (everything from the first digit to the last ` by `). Release date comes from the thread's post timestamp.

> **Note:** The APKMirror override may reject non-apkmirror.com URLs depending on your Obtainium version. If it does, use Option B.

### Option B — HTML source (version only)

| Field | Value |
|-------|-------|
| **Source URL** | `https://<your-deployment>/api/version?q=<App Name>` |
| **APK link filter** | *(leave default)* |
| **Version extraction regex** | `v([\d.]+)\.apk` |
| **Mark as track-only** | ✅ enabled |

Each result link ends with `v<version>.apk` (e.g. `…/v30.11.0.apk`). Obtainium's default `.apk` filter picks it up and the version regex captures the version number.

## How it works

Platinmods uses XenForo, which requires a CSRF-protected form POST to initiate a search. The function performs three requests on each call:

1. `GET /search/?type=post` — loads the search form to obtain a session cookie and `_xfToken` CSRF token
2. `POST /search/search` — submits the search; XenForo processes it and redirects to a cached results URL
3. `GET /search/<id>/?o=date` — re-fetches the cached results sorted by date (newest first)

Version strings are parsed from thread URL slugs: `v30-11-0` → `v30.11.0`.

## Deployment

Requires Node.js 18+ (uses native `fetch` — no npm dependencies).

```bash
npx vercel
```

## Local testing

```bash
node test.mjs BuzzKill
```
