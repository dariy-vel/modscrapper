/**
 * Vercel Serverless Function: /api/version
 *
 * Returns the latest available version of an app from Platinmods.
 *
 * GET parameters:
 *   q   - App name to search for (e.g. "BuzzKill")
 *   url - Direct Platinmods search URL (skips the search step)
 *
 * Response JSON:
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
 * Thread URLs look like:
 *   /threads/buzzkill-notification-manager-v30-11-0-mod-apk-license-check-remove.281862/
 *
 * The version segment starts with 'v' followed by digits/dashes and ends
 * before the first dash-then-letter (description) or a dot (thread ID).
 */
function extractVersionFromSlug(url) {
  // Match -vX-Y-Z or -vX-Y with a lookahead stopping before -word or .id
  const match = url.match(/-(v\d+(?:-\d+)*)(?=-[a-zA-Z]|\.\d|\/|$)/i);
  if (!match) return null;
  // Convert dashes between version parts to dots: v30-11-0 → v30.11.0
  return match[1].replace(/-/g, '.');
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

export default async function handler(req, res) {
  // Allow CORS so a front-end can call this directly
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const { q, url } = req.query ?? {};

  if (!q && !url) {
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
      return res.status(404).json({
        error: 'No versioned threads found for this query',
        search_url: resultsUrl,
      });
    }

    return res.status(200).json({
      version: results[0].version,
      thread_url: results[0].thread_url,
      all_results: results,
      search_url: resultsUrl,
      source: 'platinmods',
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
