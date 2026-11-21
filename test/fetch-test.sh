#!/usr/bin/env bash
# web_fetch extraction + search providers, entirely offline (fixtures + stubbed fetch)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
H="$HERE/../jerrito.mjs"
cd "$HERE/.." || exit 1
pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass+1)); }
no() { echo "FAIL  $1${2:+  <<< $2}"; fail=$((fail+1)); }
has() { local n="$1" s="$2" o="$3"; case "$o" in *"$s"*) ok "$n";; *) no "$n" "expected '$s' in: $(printf '%s' "$o" | tail -c 200)";; esac; }
hasnt() { local n="$1" s="$2" o="$3"; case "$o" in *"$s"*) no "$n" "unexpected '$s'";; *) ok "$n";; esac; }

echo "== web_fetch extraction (offline fixtures) =="
cat > /tmp/fetch-fixtures.mjs <<'EOF'
const { htmlToMarkdown } = await import(process.env.JERRITO_FILE);
let fail = 0;
const ok = (n, c, extra = '') => { if (c) console.log('PASS  ' + n); else { console.log('FAIL  ' + n + (extra ? '  <<< ' + extra : '')); fail++; } };

const card = (title, host) => `<article class="card"><a href="https://${host}/a"><h2>${title}</h2><p>summary of ${title}</p></a></article>`;
const index = `<html><head><title>News</title></head><body>
  <nav><a href="/x">Home</a><a href="/y">World</a></nav>
  <div class="cookie-banner">We use cookies. <button>Accept</button></div>
  <main>${Array.from({ length: 8 }, (_, i) => card('Headline ' + i, 'news.example')).join('\n')}</main>
  <div class="newsletter-signup">Subscribe to our newsletter</div>
</body></html>`;
const idx = htmlToMarkdown(index, 'https://news.example/');
ok('index page flagged', idx.indexPage === true, JSON.stringify({ indexPage: idx.indexPage }));
ok('index: card links are not bracket soup', !/\[## /.test(idx.text), idx.text.slice(0, 160));
ok('index: cookie banner removed', !/We use cookies/.test(idx.text));
ok('index: newsletter block removed', !/Subscribe to our newsletter/.test(idx.text));

const article = `<html><head><title>Deep dive</title></head><body>
  <header><a href="/">Logo</a></header>
  <main>
    <article>
      <h1>Deep dive</h1>
      ${Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i} explains the topic in real sentences, with enough words to look like prose and not a nav tile, which is the whole point of this fixture.</p>`).join('\n')}
    </article>
    <aside class="sidebar">related links</aside>
  </main>
  <footer>footer junk</footer>
</body></html>`;
const art = htmlToMarkdown(article, 'https://example.com/post');
ok('article: prose kept', /Paragraph 3 explains/.test(art.text), art.text.slice(0, 120));
ok('article: not flagged as index', art.indexPage === false);
ok('article: not flagged thin', art.thin === false);
ok('article: sidebar dropped', !/related links/.test(art.text));

const jsShell = `<html><head><title>App</title></head><body><div id="root"></div>
  <script>window.__DATA__ = {"x":1}</script></body></html>`;
const shell = htmlToMarkdown(jsShell, 'https://app.example/');
ok('JS shell flagged thin', shell.thin === true, JSON.stringify(shell));

const dupes = `<html><body><article>
  ${Array.from({ length: 5 }, () => '<p>Identical line that appears twice.</p>').join('\n')}
</article></body></html>`;
ok('repeated lines collapsed', (htmlToMarkdown(dupes, 'https://x.test/').text.match(/Identical line/g) || []).length === 1);
process.exit(fail ? 1 : 0);
EOF
out=$(JERRITO_FILE="$H" node /tmp/fetch-fixtures.mjs 2>&1); echo "$out"
pass=$((pass + $(printf '%s\n' "$out" | grep -c '^PASS')))
fail=$((fail + $(printf '%s\n' "$out" | grep -c '^FAIL')))

echo
echo "== web_fetch end-to-end messaging (stubbed network) =="
cat > /tmp/fetch-notes.mjs <<'EOF'
const { webFetch } = await import(process.env.JERRITO_FILE);
const real = globalThis.fetch;
const pages = {
  'https://news.example/': '<html><head><title>News</title></head><body><main>' +
    Array.from({ length: 8 }, (_, i) => `<article><a href="/a"><h2>Headline ${i}</h2></a></article>`).join('') +
    '</main></body></html>',
  'https://app.example/': '<html><head><title>App</title></head><body><div id="root"></div><script>var x=1</script></body></html>',
};
globalThis.fetch = async (url) => {
  const body = pages[String(url)];
  if (!body) return new Response('missing', { status: 404 });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
};
const home = await webFetch('https://news.example/');
console.log(home.startsWith('[this looks like an index/homepage') ? 'PASS  index page note' : 'FAIL  index page note <<< ' + home.slice(0, 120));
const app = await webFetch('https://app.example/');
console.log(app.includes('probably rendered by JavaScript') ? 'PASS  thin page note' : 'FAIL  thin page note <<< ' + app.slice(0, 120));
const missing = await webFetch('https://gone.example/');
console.log(missing.includes('HTTP 404') ? 'PASS  404 still reported' : 'FAIL  404 still reported <<< ' + missing);
globalThis.fetch = real;
EOF
out=$(JERRITO_FILE="$H" node /tmp/fetch-notes.mjs 2>&1); echo "$out"
pass=$((pass + $(printf '%s\n' "$out" | grep -c '^PASS')))
fail=$((fail + $(printf '%s\n' "$out" | grep -c '^FAIL')))

echo
echo "== searxng provider (offline: JSON, HTML fallback, bot check) =="
cat > /tmp/searx-test.mjs <<'EOF'
const { webSearch } = await import(process.env.JERRITO_FILE);
const real = globalThis.fetch;
const json = {
  results: [
    { title: 'Nix flakes', url: 'https://nix.dev/flakes', content: 'Flakes pin inputs.  ' },
    { title: 'Wiki', url: 'https://wiki.nixos.org/wiki/Flakes', content: 'Wiki page.' },
    { title: 'dupe', url: 'https://nix.dev/flakes', content: 'same url again' },
  ],
};
const html = `<html><body><div id="urls"><article class="result result-default">
  <h3><a href="https://example.org/a">A result</a></h3><p class="content">First description.</p></article>
  <article class="result result-default"><h3><a href="https://example.org/b">B result</a></h3>
  <p class="content">Second description.</p></article></div></body></html>`;
const bot = '<html><head><title>Making sure you&#39;re not a bot!</title></head><body>challenge</body></html>';

const mode = process.env.SX_MODE;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (!u.includes('searx.example')) return real(url);
  if (mode === 'json') return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  if (mode === 'html') return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  return new Response(bot, { status: 200, headers: { 'content-type': 'text/html' } });
};
console.log(await webSearch('nix flakes'));
EOF

export JERRITO_SEARX_URL='http://searx.example'
export JERRITO_4GET_URL=off
out=$(SX_MODE=json JERRITO_FILE="$H" node /tmp/searx-test.mjs 2>&1)
has "searx: JSON results parsed" "1) Nix flakes" "$out"
has "searx: url and description" "https://nix.dev/flakes" "$out"
has "searx: whitespace in content collapsed" "Flakes pin inputs." "$out"
hasnt "searx: duplicate url removed" "same url again" "$out"

out=$(SX_MODE=html JERRITO_FILE="$H" node /tmp/searx-test.mjs 2>&1)
has "searx: HTML fallback parsed" "1) A result" "$out"
has "searx: HTML description" "Second description." "$out"

out=$(SX_MODE=bot JERRITO_FILE="$H" node /tmp/searx-test.mjs 2>&1)
has "searx: bot check reported honestly" "blocked by the instance's bot check" "$out"

unset JERRITO_SEARX_URL
out=$(JERRITO_FILE="$H" node -e 'const { webSearch } = await import(process.env.JERRITO_FILE); const save = globalThis.fetch; globalThis.fetch = async () => { throw new Error("offline"); }; console.log(await webSearch("x"));')
hasnt "searx: not used when unset" "searxng:" "$out"

echo
unset JERRITO_4GET_URL
echo "== 4get provider (offline: JSON, scraper fallback, dead instance) =="
cat > /tmp/4get-test.mjs <<'EOF'
const { webSearch } = await import(process.env.JERRITO_FILE);
const mode = process.env.G4_MODE;
const hits = [];
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const ddg = '<html><body><a rel="nofollow" href="https://ddg.example/a" class="result-link">DDG result</a>'
  + '<td class="result-snippet">from duckduckgo</td></body></html>';
globalThis.fetch = async (url) => {
  const u = String(url);
  hits.push(u);
  if (u.includes('/api/v1/web')) {
    const scraper = new URL(u).searchParams.get('scraper');
    if (mode === 'ok') return json({ status: 'ok', web: [
      { title: 'Four result', description: '  from 4get  ', url: 'https://four.example/a' },
      { title: 'Duplicate', description: 'dup', url: 'https://four.example/a' }] });
    if (mode === 'scraper') return scraper === 'ddg'
      ? json({ status: 'DuckDuckGo detected an anomaly' })
      : json({ status: 'ok', web: [{ title: 'Brave via 4get', description: 'b', url: 'https://four.example/b' }] });
    if (mode === 'down') return new Response('down', { status: 503 });
    if (mode === 'bot') return new Response('<html>make sure you are not a bot</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }
  if (u.includes('duckduckgo')) return new Response(ddg, { status: 200, headers: { 'content-type': 'text/html' } });
  if (u.includes('brave.com')) return new Response('<html></html>', { status: 429 });
  throw new Error('unexpected url ' + u);
};
console.log(await webSearch('nix'));
console.log('HITS=' + hits.map((h) => h.replace(/^https?:\/\//, '').split('/')[0]).join(','));
EOF

out=$(HOME=/tmp/fakehome-4get-fetch JERRITO_4GET_FINDER=off G4_MODE=ok JERRITO_FILE="$H" node /tmp/4get-test.mjs 2>&1)
has "4get: JSON results parsed" "1) Four result" "$out"
has "4get: description whitespace collapsed" "from 4get" "$out"
hasnt "4get: duplicate url removed" "Duplicate" "$out"
has "4get: first reachable instance used" "HITS=4get.ca" "$out"

out=$(HOME=/tmp/fakehome-4get-fetch JERRITO_4GET_FINDER=off G4_MODE=scraper JERRITO_FILE="$H" node /tmp/4get-test.mjs 2>&1)
has "4get: retries another scraper after an upstream block" "Brave via 4get" "$out"

out=$(HOME=/tmp/fakehome-4get-fetch JERRITO_4GET_FINDER=off G4_MODE=down JERRITO_FILE="$H" node /tmp/4get-test.mjs 2>&1)
has "4get: 503 falls back to duckduckgo" "DDG result" "$out"
has "4get: fallback visible in hits" "duckduckgo" "$out"

out=$(HOME=/tmp/fakehome-4get-fetch JERRITO_4GET_FINDER=off G4_MODE=bot JERRITO_FILE="$H" node /tmp/4get-test.mjs 2>&1)
has "4get: bot-walled instance falls back" "DDG result" "$out"

out=$(HOME=/tmp/fakehome-4get-fetch JERRITO_4GET_FINDER=off JERRITO_4GET_URL=off G4_MODE=ok JERRITO_FILE="$H" node /tmp/4get-test.mjs 2>&1)
hasnt "4get: JERRITO_4GET_URL=off disables it" "4get.ca" "$out"
has "4get: off still searches duckduckgo" "DDG result" "$out"
echo
echo "== summary: $pass passed, $fail failed =="
[ "$fail" = 0 ]
