/**
 * Vercel Serverless Function: /api/version
 *
 * Returns the latest available version of an app from Platinmods.
 *
 * GET parameters:
 *   q      - App name to search for (e.g. "BuzzKill")
 *   url    - Direct Platinmods search URL (skips the search step)
 *   format - "html" (default) | "json" | "rss"
 *            "html" returns an Obtainium HTML source page (see README)
 *            "rss"  returns an APKMirror-compatible RSS feed (see README)
 *
 * Response HTML (default):
 *   Minimal HTML page with one <a> per result whose href ends in
 *   "v{version}.apk", suitable for Obtainium's HTML source.
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
 * or a dot followed by a digit (thread ID).
 */
function extractVersionFromSlug(url) {
  // v(?:er)? matches both "v" and "ver"; -? absorbs the separator dash in "ver-"
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
 * Re-write the `o` (order-by) parameter in a Platinmods search URL to 'date'.
 */
function withDateOrder(url) {
  if (/[?&]o=/.test(url)) {
    return url.replace(/([?&]o=)[^&]+/, '$1date');
  }
  return url + (url.includes('?') ? '&' : '?') + 'o=date';
}

/**
 * Render an Obtainium-compatible HTML page from a results array.
 *
 * Each result gets one <a> whose href is the platinmods thread URL with
 * "vX.Y.Z.apk" appended as a path suffix.  This gives Obtainium a link
 * that (a) ends in .apk so the default filter passes it, and (b) contains
 * the version string in the filename for extraction.
 */
function buildHtml(appName, results) {
  const links = results
    .map(({ version, thread_url }) => {
      const apkHref = `${thread_url}${version}.apk`;
      return `  <li><a href="${apkHref}">${appName} ${version}</a> — <a href="${thread_url}">thread</a></li>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${appName} – Platinmods version tracker</title></head>
<body>
<ul>
${links}
</ul>
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
 *
 * Title format: "AppName X.Y.Z by Platinmods"
 *   – version has no "v" prefix so the first digit is unambiguous
 *   – works as long as the app name itself contains no digits
 *
 * The Vercel rewrite  /api/:app/feed  →  /api/version?q=:app&format=rss
 * makes this endpoint addressable at the URL APKMirror expects.
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

  const { q, url, format = 'html' } = req.query ?? {};

  if (!q && !url) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({
      error: 'Provide either ?q=<app name> or ?url=<platinmods search URL>',
    });
  }

  try {
    let resultsHtml;
    let resultsUrl;

    // ── Branch A: caller supplied a direct search URL ────────────────────
    if (url) {
      const dateUrl = withDateOrder(url);
      const resp = await fetch(dateUrl, { headers: HEADERS });

      if (!resp.ok) {
        return res
          .status(502)
          .json({ error: `Platinmods returned HTTP ${resp.status}` });
      }

      resultsHtml = await resp.text();
      resultsUrl = resp.url;

    // ── Branch B: search by app name ─────────────────────────────────────
    } else {
      // Step 1 – load the search form to grab a session cookie + CSRF token
      const formPageResp = await fetch(
        `${PLATINMODS_BASE}/search/?type=post`,
        { headers: HEADERS }
      );

      if (!formPageResp.ok) {
        return res
          .status(502)
          .json({ error: 'Failed to load Platinmods search page' });
      }

      const formPageHtml = await formPageResp.text();
      const sessionCookies = parseCookies(formPageResp);

      const tokenMatch = formPageHtml.match(
        /name=['"]_xfToken['"][^>]*value=['"]([^'"]+)['"]/
      );
      if (!tokenMatch) {
        return res
          .status(502)
          .json({ error: 'Could not extract CSRF token from search page' });
      }
      const xfToken = tokenMatch[1];

      // Step 2 – POST the search; fetch follows the redirect automatically
      const body = new URLSearchParams({
        keywords: q,
        'c[title_only]': '1',
        _xfToken: xfToken,
      });

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
        return res
          .status(502)
          .json({ error: `Search POST failed with HTTP ${searchResp.status}` });
      }

      // Step 3 – re-fetch the same search with date ordering
      const rawSearchUrl = searchResp.url;
      const dateSearchUrl = withDateOrder(rawSearchUrl);

      const dateResp = await fetch(dateSearchUrl, {
        headers: { ...HEADERS, Cookie: sessionCookies },
      });

      if (!dateResp.ok) {
        return res
          .status(502)
          .json({ error: 'Failed to fetch date-ordered search results' });
      }

      resultsHtml = await dateResp.text();
      resultsUrl = dateResp.url;
    }

    // ── Parse results ─────────────────────────────────────────────────────
    const results = parseResults(resultsHtml);

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

    // ── Respond ───────────────────────────────────────────────────────────
    const appName = q || url;

    if (format === 'rss') {
      const selfUrl = `${PLATINMODS_BASE}/search/?q=${encodeURIComponent(q || url)}`;
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
    return res.status(200).send(buildHtml(appName, results));

  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ error: err.message });
  }
}
