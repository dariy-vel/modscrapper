/**
 * Quick smoke-test – runs the scraping logic directly without Vercel.
 * Usage:  node test.mjs [app-name]  (defaults to BuzzKill)
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

function extractVersionFromSlug(url) {
  const match = url.match(/-(v\d+(?:-\d+)*)(?=-[a-zA-Z]|\.\d|\/|$)/i);
  if (!match) return null;
  return match[1].replace(/-/g, '.');
}

function parseCookies(response) {
  let cookies = [];
  if (typeof response.headers.getSetCookie === 'function') {
    cookies = response.headers.getSetCookie();
  } else {
    const raw = response.headers.get('set-cookie');
    if (raw) cookies = [raw];
  }
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

function parseResults(html) {
  const seen = new Set();
  const results = [];
  for (const [, href] of html.matchAll(/href="(\/threads\/[^"]+)"/gi)) {
    if (seen.has(href)) continue;
    seen.add(href);
    const version = extractVersionFromSlug(href);
    if (version) results.push({ version, thread_url: `${PLATINMODS_BASE}${href}` });
  }
  return results;
}

function withDateOrder(url) {
  if (/[?&]o=/.test(url)) return url.replace(/([?&]o=)[^&]+/, '$1date');
  return url + (url.includes('?') ? '&' : '?') + 'o=date';
}

async function run(appName) {
  console.log(`\nSearching for: "${appName}"\n`);

  // Step 1: get CSRF token
  console.log('Step 1: Fetching search form...');
  const formResp = await fetch(`${PLATINMODS_BASE}/search/?type=post`, { headers: HEADERS });
  const formHtml = await formResp.text();
  const cookies = parseCookies(formResp);

  const tokenMatch = formHtml.match(/name=['"]_xfToken['"][^>]*value=['"]([^'"]+)['"]/);
  if (!tokenMatch) throw new Error('CSRF token not found');
  const token = tokenMatch[1];
  console.log('  Token:', token.substring(0, 20) + '...');

  // Step 2: POST search
  console.log('Step 2: Posting search...');
  const body = new URLSearchParams({ keywords: appName, 'c[title_only]': '1', _xfToken: token });
  const searchResp = await fetch(`${PLATINMODS_BASE}/search/search`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
    body: body.toString(),
  });
  console.log('  Redirected to:', searchResp.url);

  // Step 3: re-fetch with date order
  const dateUrl = withDateOrder(searchResp.url);
  console.log('Step 3: Fetching date-ordered results:', dateUrl);
  const dateResp = await fetch(dateUrl, { headers: { ...HEADERS, Cookie: cookies } });
  const html = await dateResp.text();

  const results = parseResults(html);
  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  console.log(`\nFound ${results.length} result(s):`);
  results.forEach((r, i) => console.log(`  [${i + 1}] ${r.version}  →  ${r.thread_url}`));
  console.log(`\nLatest version: ${results[0].version}`);
}

const appName = process.argv[2] ?? 'BuzzKill';
run(appName).catch((e) => { console.error('Error:', e.message); process.exit(1); });
