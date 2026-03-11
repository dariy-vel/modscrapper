/**
 * Vercel Serverless Function: /api/version
 *
 * Returns the latest available version of an app from Platinmods.
 *
 * GET parameters:
 *   q      - App name to search for (e.g. "BuzzKill")
 *   url    - Platinmods thread URL  → version extracted from slug (no HTTP)
 *            Platinmods search URL  → fetches and parses the results page
 *   author - Author/publisher label shown in the HTML index; injected
 *            automatically by the /apk/:author/:app Vercel rewrite
 *   format - "html" (default) | "json" | "rss"
 *            "html" returns an Obtainium HTML source page + human index
 *            "rss"  returns an APKMirror-compatible RSS feed (see README)
 *
 * Response HTML (default):
 *   Page with one <a> per result whose href ends in "v{version}.apk",
 *   suitable for Obtainium's HTML source.  Also contains a #whatsnew
 *   JS redirect to the most recent Platinmods thread.
 *
 * Response RSS (?format=rss):
 *   RSS 2.0 feed with one <item> per result; title format matches what
 *   Obtainium's APKMirror source parser expects: "AppName X.Y.Z by Platinmods"
 *
 * Response JSON (?format=json):
 *   { version, thread_url, all_results, search_url, source }
 */

const PLATINMODS_BASE = 'https://platinmods.com';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Extract a semantic version string from a Platinmods thread URL slug.
 *
 * Handles two slug conventions:
 *   -v30-11-0-mod-apk    →  v30.11.0   (most threads)
 *   -ver-1-32-8-mod-apk  →  v1.32.8    (some "Ver. X.Y.Z" titles)
 *
 * The version segment ends before the first dash-then-letter (description)
 * or a dot followed by a digit (thread ID suffix).
 */
function extractVersionFromSlug(url) {
  // v(?:er)? matches both "v" and "ver"; -? absorbs the separator in "ver-"
  const match = url.match(/-(v(?:er)?-?)(\d+(?:-\d+)*)(?=-[a-zA-Z]|\.\d|\/|$)/i);
  if (!match) return null;
  // Always normalise to "vX.Y.Z" regardless of whether slug used "v" or "ver"
  return 'v' + match[2].replace(/-/g, '.');
}

/**
 * Parse Set-Cookie response headers into a single Cookie header string.
 * Works with Node 18+ Headers which expose getSetCookie().
 */
function parseCookies(response) {
  let cookies = [];
  if (typeof response.headers.getSetCookie === 'function') {
    cookies = response.headers.getSetCookie();
  } else {
    // Fallback: concatenated string (rare, but defensive)
    const raw = response.headers.get('set-cookie');
    if (raw) cookies = [raw];
  }
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

/**
 * Parse unique thread links + post dates from a Platinmods search-results page.
 *
 * Dates come from <time class="u-dt" datetime="ISO8601"> elements.
 * XenForo emits exactly one such element per search result row, in the same
 * document order as the thread links, so we zip them together by position.
 */
function parseResults(html) {
  const seen = new Set();
  const results = [];

  for (const [, href] of html.matchAll(/href="(\/threads\/[^"]+)"/gi)) {
    if (seen.has(href)) continue;
    seen.add(href);

    const version = extractVersionFromSlug(href);
    if (version) {
      results.push({ version, thread_url: `${PLATINMODS_BASE}${href}`, pubDate: null });
    }
  }

  // Extract ISO 8601 dates from XenForo's <time class="u-dt"> elements
  const dates = [
    ...html.matchAll(/<time\b[^>]*class="u-dt"[^>]*datetime="([^"]+)"/gi),
  ].map((m) => m[1]);

  results.forEach((r, i) => {
    if (dates[i]) r.pubDate = dates[i];
  });

  return results;
}

/**
 * Compare two result objects by semantic version, descending (highest first).
 * Handles any number of dot-separated numeric segments.
 */
function compareVersionsDesc(a, b) {
  const av = a.version.replace(/^v/i, '').split('.').map(Number);
  const bv = b.version.replace(/^v/i, '').split('.').map(Number);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const diff = (bv[i] ?? 0) - (av[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Return true if s looks like an Android package name (e.g. "io.appground.blek").
 * Used to switch from title-only to full-text search so Platinmods matches
 * the Play Store URL in the thread body rather than the thread title.
 */
function isPackageName(s) {
  return /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)+$/i.test(s);
}

/**
 * Re-write the `o` (order-by) parameter in a Platinmods search URL to 'date'.
 */
function withDateOrder(url) {
  if (/[?&]o=/.test(url)) {
    return url.replace(/([?&]o=)[^&]+/, '$1date');
  }
  return url + (url.includes('?') ? '&' : '?') + 'o=date';
}

/**
 * Derive a human-readable app name from a Platinmods URL when ?q= is absent.
 *   Thread URL: title-case the slug up to the version marker.
 *   Search URL: extract the value of the ?q= parameter.
 */
function nameFromUrl(url) {
  if (!url) return null;

  // Thread URL: /threads/app-name-v30-11-0-mod-apk.12345/
  const threadMatch = url.match(/\/threads\/([^/?#]+)/);
  if (threadMatch) {
    const slug = threadMatch[1].replace(/-(v(?:er)?-?\d+.*)$/, '');
    return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Search URL: ?q=BuzzKill or ?keywords=BuzzKill
  try {
    const params = new URL(url).searchParams;
    return params.get('q') ?? params.get('keywords') ?? null;
  } catch {
    return null;
  }
}

/**
 * Render an HTML index page listing all available releases.
 *
 * Dual-purpose:
 *  1. Obtainium HTML source — each <a href="...vX.Y.Z.apk"> is detected by
 *     the default ".apk" link filter; version extracted via regex vX.Y.Z.apk
 *  2. Human browsing — "thread ↗" links go straight to Platinmods
 *
 * #whatsnew handling:
 *  When Obtainium opens {appUrl}#whatsnew (the "What's New" button), the
 *  inline script detects the hash and redirects the browser to the most
 *  recent Platinmods thread automatically.
 */
function buildHtml(appName, results, author) {
  const authorHtml = author
    ? ` <span style="font-size:.85em;color:#888">by ${author}</span>`
    : '';

  const items = results
    .map(({ version, thread_url }) => {
      const apkHref = `${thread_url}${version}.apk`;
      return (
        `  <li>` +
        `<a href="${apkHref}">${appName} ${version}</a>` +
        ` — <a class="thread" href="${thread_url}">thread ↗</a>` +
        `</li>`
      );
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${appName} – Platinmods</title></head>
<body>
<h2>${appName}${authorHtml}</h2>
<ul>
${items}
</ul>
<script>
if (location.hash === '#whatsnew') {
  var t = document.querySelector('a.thread');
  if (t) location.replace(t.href);
}
</script>
</body>
</html>`;
}

/**
 * Render an APKMirror-compatible RSS 2.0 feed.
 *
 * Obtainium's APKMirror source parser:
 *   1. Fetches {url}/feed/
 *   2. Selects all <item> elements
 *   3. Extracts version: substring from first digit to last " by " in <title>
 *   4. Extracts date from <pubDate>
 *   5. Uses the second URL path segment as author, third as app name
 *
 * Title format: "AppName X.Y.Z by Platinmods"
 *   – no "v" prefix so the first digit is the unambiguous version start
 */
function buildRss(appName, results, selfUrl) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const items = results
    .map(({ version, thread_url, pubDate }) => {
      // Strip leading "v" so the first character is a digit
      const ver = version.replace(/^v/, '');
      const title = esc(`${appName} ${ver} by Platinmods`);
      const pub = pubDate ? new Date(pubDate).toUTCString() : new Date().toUTCString();
      return `    <item>
      <title>${title}</title>
      <link>${esc(thread_url)}</link>
      <pubDate>${pub}</pubDate>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(appName)} – Platinmods</title>
    <link>${esc(selfUrl)}</link>
    <description>Latest ${esc(appName)} versions on Platinmods</description>
${items}
  </channel>
</rss>`;
}

export default async function handler(req, res) {
  // Allow CORS so a front-end can call this directly
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { q, url, format = 'html', author } = req.query ?? {};

  if (!q && !url) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({
      error: 'Provide either ?q=<app name> or ?url=<platinmods thread or search URL>',
    });
  }

  try {
    let results;
    let resultsUrl;

    // ── Branch A: thread URL — extract from slug, zero HTTP requests ──────────
    //
    // If the caller supplies a direct thread URL such as
    //   https://platinmods.com/threads/buzzkill-v30-11-0-mod-apk.123/
    // we can read the version straight from the slug without any scraping.
    if (url && /\/threads\//.test(url)) {
      const threadUrl = url.replace(/[?#].*$/, ''); // strip query string + hash
      const version = extractVersionFromSlug(threadUrl);
      if (!version) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(404).json({
          error: 'Could not extract version from thread URL slug',
        });
      }
      results = [{ version, thread_url: threadUrl, pubDate: null }];
      resultsUrl = threadUrl;

    // ── Branch B: search results URL ─────────────────────────────────────────
    } else if (url) {
      const resp = await fetch(withDateOrder(url), { headers: HEADERS });
      if (!resp.ok) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(502).json({ error: `Platinmods returned HTTP ${resp.status}` });
      }
      results = parseResults(await resp.text());
      resultsUrl = resp.url;

    // ── Branch C: search by app name ─────────────────────────────────────────
    } else {
      // Step 1 – load the search form to grab a session cookie + CSRF token
      const formPageResp = await fetch(
        `${PLATINMODS_BASE}/search/?type=post`,
        { headers: HEADERS }
      );
      if (!formPageResp.ok) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(502).json({ error: 'Failed to load Platinmods search page' });
      }

      const formPageHtml = await formPageResp.text();
      const sessionCookies = parseCookies(formPageResp);

      const tokenMatch = formPageHtml.match(
        /name=['"]_xfToken['"][^>]*value=['"]([^'"]+)['"]/
      );
      if (!tokenMatch) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(502).json({ error: 'Could not extract CSRF token from search page' });
      }

      // Step 2 – POST the search; fetch follows the redirect automatically
      // Package-name queries use full-text search (no title_only) so Platinmods
      // matches the Play Store URL in the thread body, which contains the package ID.
      // App-name queries use title_only to avoid unrelated posts mentioning the name.
      const body = new URLSearchParams({ keywords: q, _xfToken: tokenMatch[1] });
      if (!isPackageName(q)) body.set('c[title_only]', '1');

      const searchResp = await fetch(
        `${PLATINMODS_BASE}/search/search`,
        {
          method: 'POST',
          headers: {
            ...HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: sessionCookies,
            Referer: `${PLATINMODS_BASE}/search/?type=post`,
          },
          body: body.toString(),
        }
      );
      if (!searchResp.ok) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(502).json({ error: `Search POST failed with HTTP ${searchResp.status}` });
      }

      // Step 3 – re-fetch the cached results with date ordering
      const dateResp = await fetch(withDateOrder(searchResp.url), {
        headers: { ...HEADERS, Cookie: sessionCookies },
      });
      if (!dateResp.ok) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(502).json({ error: 'Failed to fetch date-ordered search results' });
      }

      results = parseResults(await dateResp.text());
      resultsUrl = dateResp.url;
    }

    // Sort by version descending so the highest version is always first,
    // regardless of which thread was posted/updated most recently.
    results.sort(compareVersionsDesc);

    // ── Validate ──────────────────────────────────────────────────────────────
    if (results.length === 0) {
      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        return res.status(404).json({
          error: 'No versioned threads found for this query',
          search_url: resultsUrl,
        });
      }
      res.setHeader('Content-Type', format === 'rss' ? 'application/rss+xml' : 'text/html');
      return res.status(404).send('<p>No versioned threads found.</p>');
    }

    // ── Derive app name ───────────────────────────────────────────────────────
    // When q is a package name, read the human title from the top result's slug
    // (e.g. "bluetooth-keyboard-mouse-ver-..." → "Bluetooth Keyboard Mouse").
    // Otherwise use q as-is, or derive from the URL, or fall back to 'App'.
    const appName =
      (q && isPackageName(q) ? nameFromUrl(results[0].thread_url) : null)
      ?? q
      ?? nameFromUrl(url)
      ?? 'App';

    // ── Respond ───────────────────────────────────────────────────────────────
    if (format === 'rss') {
      const selfUrl = `${PLATINMODS_BASE}/search/?q=${encodeURIComponent(appName)}`;
      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      return res.status(200).send(buildRss(appName, results, selfUrl));
    }

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({
        version: results[0].version,
        thread_url: results[0].thread_url,
        all_results: results,
        search_url: resultsUrl,
        source: 'platinmods',
      });
    }

    // default: html
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(buildHtml(appName, results, author));

  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ error: err.message });
  }
}
