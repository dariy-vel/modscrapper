/**
 * Vercel Serverless Function: /api/version
 *
 * Returns the latest available version of an app from Platinmods.
 *
 * GET parameters:
 *   q      - App name to search for (e.g. "BuzzKill")
 *   url    - Direct Platinmods search URL (skips the search step)
 *   format - "json" (default) | "html"
 *            "html" returns an Obtainium-compatible HTML page (see README)
 *
 * Response JSON (default):
 *   { version, thread_url, all_results, search_url, source }
 *
 * Response HTML (?format=html):
 *   Minimal HTML page with one <a> per result whose href ends in
 *   "v{version}.apk", suitable for Obtainium's HTML source.
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
 * Parse unique thread links from a Platinmods search-results HTML page
 * and extract version numbers from each slug.
 */
function parseResults(html) {
  const seen = new Set();
  const results = [];

  for (const [, href] of html.matchAll(/href="(\/threads\/[^"]+)"/gi)) {
    if (seen.has(href)) continue;
    seen.add(href);

    const version = extractVersionFromSlug(href);
    if (version) {
      results.push({ version, thread_url: `${PLATINMODS_BASE}${href}` });
    }
  }

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
 * "/vX.Y.Z.apk" appended as a path suffix.  This gives Obtainium a link
 * that (a) ends in .apk so the default filter passes it, and (b) contains
 * the version string in the filename for extraction.
 *
 * Obtainium setup:
 *   - Source URL : https://<your-deployment>/api/version?q=<app>+format=html
 *   - APK link filter  : (leave default – matches *.apk)
 *   - Version regex    : v([\d.]+)\.apk
 *   - Enable "Mark as track-only" (platinmods downloads require auth)
 */
function buildHtml(appName, results) {
  const links = results
    .map(({ version, thread_url }) => {
      // Append /vX.Y.Z.apk so the filename carries the version
      const href = `${thread_url}${version}.apk`;
      return `  <li><a href="${href}">${appName} ${version}</a></li>`;
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

export default async function handler(req, res) {
  // Allow CORS so a front-end can call this directly
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { q, url, format } = req.query ?? {};
  const wantHtml = format === 'html';

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
      const rawSearchUrl = searchResp.url; // e.g. /search/12345/?q=...&o=relevance
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
      if (wantHtml) {
        res.setHeader('Content-Type', 'text/html');
        return res.status(404).send('<p>No versioned threads found.</p>');
      }
      res.setHeader('Content-Type', 'application/json');
      return res.status(404).json({
        error: 'No versioned threads found for this query',
        search_url: resultsUrl,
      });
    }

    // ── Respond ───────────────────────────────────────────────────────────
    if (wantHtml) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(buildHtml(q || url, results));
    }

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      version: results[0].version,
      thread_url: results[0].thread_url,
      all_results: results,
      search_url: resultsUrl,
      source: 'platinmods',
    });

  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ error: err.message });
  }
}
