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

### Use a Platinmods URL directly

Pass a thread URL to skip scraping entirely — the version is read straight from the slug, no HTTP requests:

```
GET /api/version?url=https://platinmods.com/threads/buzzkill-v30-11-0-mod-apk.281862/
```

Or pass a search results URL (e.g. copied from the browser) to use a specific query:

```
GET /api/version?url=https://platinmods.com/search/157784990/?q=BuzzKill&c[title_only]=1&o=date
```

### Response formats

| Parameter | Content-Type | Description |
|-----------|-------------|-------------|
| *(default)* | `text/html` | HTML index page (Obtainium-compatible) |
| `&format=json` | `application/json` | Machine-readable |
| `&format=rss` | `application/rss+xml` | APKMirror-compatible RSS feed |

#### JSON response

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

---

## Obtainium integration

> **Track-only** — Platinmods requires authentication to download files, so Obtainium will detect version changes but you'll need to download the APK manually.

Two source types are supported. **Option A (APKMirror)** is recommended — it also surfaces the release date.

### Option A — APKMirror source (version + release date)

The `/apk/<Author>/<AppName>` URL structure is designed to satisfy Obtainium's APKMirror source parser, which:
- validates that the URL path contains `/apk/<org>/<app>`
- fetches `{url}/feed/` to get the RSS feed
- uses `<Author>` (the second path segment) as the developer name in the app entry

| Field | Value |
|-------|-------|
| **App source URL** | `https://<your-deployment>/apk/Platinmods/<App Name>` |
| **Override source** | APKMirror |
| **Mark as track-only** | ✅ enabled |

Example: `https://<your-deployment>/apk/Platinmods/BuzzKill`

- Obtainium shows **Platinmods** as the developer name (from the URL segment — you can use any label you like)
- Obtainium fetches `…/apk/Platinmods/BuzzKill/feed/`, which returns RSS:

```xml
<item>
  <title>BuzzKill 30.11.0 by Platinmods</title>
  <pubDate>Thu, 06 Feb 2026 03:04:00 GMT</pubDate>
</item>
```

Version is extracted from the title (first digit → last ` by `). Release date comes from the thread's post timestamp.

#### What's New

When you tap **What's New** in Obtainium, it opens `{appUrl}/#whatsnew` in a browser. The index page detects this hash and redirects automatically to the latest Platinmods thread.

### Option B — HTML source (version only)

| Field | Value |
|-------|-------|
| **Source URL** | `https://<your-deployment>/api/version?q=<App Name>` |
| **APK link filter** | *(leave default)* |
| **Version extraction regex** | `v([\d.]+)\.apk` |
| **Mark as track-only** | ✅ enabled |

Each result link ends with `v<version>.apk` (e.g. `…/v30.11.0.apk`). Obtainium's default `.apk` filter picks it up and the version regex captures the version number.

---

## App index pages

Browsing to `/apk/<Author>/<AppName>` directly in a browser shows a human-readable release list:

```
https://<your-deployment>/apk/Platinmods/BuzzKill
```

Each row links to both the synthetic `.apk` URL (for Obtainium) and the real Platinmods thread.

---

## How it works

Platinmods uses XenForo, which requires a CSRF-protected form POST to initiate a search. The function performs three requests on each `?q=` call:

1. `GET /search/?type=post` — loads the search form to obtain a session cookie and `_xfToken` CSRF token
2. `POST /search/search` — submits the search; XenForo processes it and redirects to a cached results URL
3. `GET /search/<id>/?o=date` — re-fetches the cached results sorted by date (newest first)

When `?url=` points at a thread URL (`/threads/…`), steps 1–3 are skipped entirely — the version is read directly from the URL slug.

Version strings are parsed from thread URL slugs: `v30-11-0` → `v30.11.0`.

---

## Deployment

Requires Node.js 18+ (uses native `fetch` — no npm dependencies).

```bash
npx vercel
```

## Local testing

```bash
node test.mjs BuzzKill
```
