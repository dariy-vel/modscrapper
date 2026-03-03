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

### Response

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
