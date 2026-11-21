#!/usr/bin/env bash
# 4get instance auto-update: finder parsing, cache TTL, self-healing (all offline)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
H="$HERE/../helper.mjs"
cd "$HERE/.." || exit 1
FAKE=/tmp/fakehome-4get
FINDER='https://finder.example/config.php'
pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass+1)); }
no() { echo "FAIL  $1${2:+  <<< $2}"; fail=$((fail+1)); }
has() { local n="$1" s="$2" o="$3"; case "$o" in *"$s"*) ok "$n";; *) no "$n" "expected '$s' in: $(printf '%s' "$o" | tail -c 200)";; esac; }
hasnt() { local n="$1" s="$2" o="$3"; case "$o" in *"$s"*) no "$n" "unexpected '$s'";; *) ok "$n";; esac; }
cache_field() { HOME="$FAKE" node -e 'try{const j=require(process.env.HOME+"/.cache/helper/4get-instances.json");console.log(j'"$1"')}catch{console.log("")}'; }

cat > /tmp/fourget-instance-test.mjs <<'EOF'
const { webSearch } = await import(process.env.HELPER_FILE);
const mode = process.env.G4_MODE;
const hits = [];
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const cfg = (urls) => '<?php\nclass config {\n\tconst INSTANCES = [\n'
  + urls.map((u) => `\t\t"${u}",`).join('\n') + '\n\t];\n}\n';
const result = (name) => json({ status: 'ok', web: [{ title: name, description: 'd', url: 'https://x.example/a' }] });
let finderCalls = 0, round = 0;

globalThis.fetch = async (url) => {
  const u = String(url);
  hits.push(u);
  if (u.startsWith('https://finder.example')) {
    finderCalls++;
    if (mode === 'finder-down') return new Response('nope', { status: 503 });
    if (mode === 'list-changes') {
      round++;
      return new Response(cfg(round === 1 ? ['https://dead.example'] : ['https://live.example']),
        { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (mode === 'finder-json') return json(['https://live.example/', 'https://other.example']);
    return new Response(cfg(['https://live.example', 'https://other.example/', 'https://live.example']),
      { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  if (u.includes('/api/v1/web')) {
    if (u.startsWith('https://dead.example')) throw new Error('connect ECONNREFUSED');
    if (u.startsWith('https://live.example')) return result('From live');
    if (u.startsWith('https://other.example')) return result('From other');
  }
  throw new Error('unexpected url ' + u);
};

console.log(await webSearch('q'));
console.log('FINDER_CALLS=' + finderCalls);
console.log('HOSTS=' + [...new Set(hits.map((h) => h.replace(/^https?:\/\//, '').split('/')[0]))].join(','));
EOF

run() { HOME="$FAKE" HELPER_4GET_FINDER="$FINDER" HELPER_FILE="$H" node /tmp/fourget-instance-test.mjs 2>&1; }
reset() { rm -rf "$FAKE"; mkdir -p "$FAKE"; }

echo "== instance finder + cache =="
reset
out=$(G4_MODE=ok run)
has "instances: finder list parsed" "From live" "$out"
has "instances: finder called once on first run" "FINDER_CALLS=1" "$out"
has "instances: deduped, trailing slash trimmed" "https://live.example https://other.example" "$(cache_field ".instances.join(' ')")"

out=$(G4_MODE=ok run)
has "instances: fresh cache does not re-fetch" "FINDER_CALLS=0" "$out"
case "$out" in *"From live"*|*"From other"*) ok "instances: still searches from cache";; *) no "instances: still searches from cache" "$(printf %s "$out" | head -c 120)";; esac

reset
out=$(G4_MODE=finder-json run)
has "instances: JSON finder payload accepted" "From live" "$out"

echo
echo "== staleness and outages =="
HOME="$FAKE" node -e 'const fs=require("fs");const f=process.env.HOME+"/.cache/helper/4get-instances.json";const j=JSON.parse(fs.readFileSync(f));j.at=0;fs.writeFileSync(f,JSON.stringify(j))'
out=$(G4_MODE=ok run)
has "instances: stale cache refreshed" "FINDER_CALLS=1" "$out"

out=$(G4_MODE=finder-down run)
has "instances: finder outage falls back to cache" "From live" "$out"
has "instances: outage did not lose the cache" "live.example" "$(cache_field ".instances.join(' ')")"

reset
out=$(G4_MODE=finder-down run)
has "instances: no cache + dead finder uses built-ins" "4get.ca" "$out"

echo
echo "== explicit config and self-healing =="
reset
out=$(HOME="$FAKE" HELPER_4GET_URL=https://live.example HELPER_4GET_FINDER="$FINDER" G4_MODE=ok HELPER_FILE="$H" node /tmp/fourget-instance-test.mjs 2>&1)
has "instances: explicit HELPER_4GET_URL is used" "From live" "$out"
has "instances: explicit list skips the finder" "FINDER_CALLS=0" "$out"

reset
out=$(HOME="$FAKE" HELPER_4GET_FINDER=off G4_MODE=ok HELPER_FILE="$H" node /tmp/fourget-instance-test.mjs 2>&1)
has "instances: finder can be turned off" "FINDER_CALLS=0" "$out"
has "instances: falls back to built-ins when off" "4get.ca" "$out"

reset
out=$(G4_MODE=list-changes run)
has "instances: re-reads finder when every instance is dead" "From live" "$out"
has "instances: finder consulted twice in that case" "FINDER_CALLS=2" "$out"

reset
G4_MODE=ok run >/dev/null
c1=$(cache_field .cursor)
G4_MODE=ok run >/dev/null
c2=$(cache_field .cursor)
[ "$c1" != "$c2" ] && ok "instances: rotation cursor advances between searches" || no "instances: rotation cursor advances" "$c1 -> $c2"
case "$(cache_field .cursor)" in ""|*[!0-9]*) no "instances: numeric rotation cursor in cache" "$(cache_field .cursor)" ;; *) ok "instances: numeric rotation cursor in cache" ;; esac

rm -rf "$FAKE"
echo
echo "== summary: $pass passed, $fail failed =="
[ "$fail" = 0 ]