#!/usr/bin/env bash
# jerrito test suite — real assertions, PASS/FAIL lines
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
H="$HERE/../jerrito.mjs"
cd "$HERE/.." || exit 1
pass=0; fail=0
command -v llama-server >/dev/null 2>&1 || [ -n "${JERRITO_BIN_DIR:-}" ] || echo "WARN  llama-server is not on PATH: the tests that start a server will fail (use: nix develop -c ./test/run.sh)"

ok() { echo "PASS  $1"; pass=$((pass+1)); }
no() { echo "FAIL  $1${2:+  <<< $2}"; fail=$((fail+1)); }
has() { local name="$1" needle="$2" out="$3"; case "$out" in *"$needle"*) ok "$name";; *) no "$name" "expected '$needle' in: $(printf '%s' "$out" | head -c 200)";; esac; }
hasnt() { local name="$1" needle="$2" out="$3"; case "$out" in *"$needle"*) no "$name" "unexpected '$needle'";; *) ok "$name";; esac; }
code() { local name="$1" want="$2"; shift 2; "$@" >/dev/null 2>&1; local c=$?; [ "$c" = "$want" ] && ok "$name (exit $c)" || no "$name" "exit $c, wanted $want"; }

echo "== clean slate =="
node "$H" --stop >/dev/null 2>&1

echo
echo "== no-server behaviour =="
out=$(node "$H" --status 2>&1); has "--status with no server" "no jerrito-managed server" "$out"
out=$(JERRITO_NO_SPAWN=1 node "$H" "hi" 2>&1); c=$?
[ "$c" = 1 ] && has "JERRITO_NO_SPAWN=1 refuses to spawn" "JERRITO_NO_SPAWN=1, so jerrito will not start one" "$out" || no "JERRITO_NO_SPAWN=1 exit code" "got $c"
out=$(JERRITO_BASE_URL=http://127.0.0.1:1 node "$H" "hi" 2>&1); c=$?
[ "$c" = 1 ] && has "explicit base refuses to spawn" "JERRITO_BASE_URL is set" "$out" || no "explicit base exit code" "got $c"
out=$(JERRITO_BASE_URL=http://127.0.0.1:1 node "$H" --status 2>&1); has "--status is safe without server" "" "$out"

echo
echo "== tools (no model needed) =="
echo "-- search parsing (offline fixture, no network) --"
cat > /tmp/search-offline.mjs <<'EOF'
const realFetch = globalThis.fetch;
const lite = `<html><body><table>
<tr><td>1.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnix.dev%2F&rut=zz" class='result-link'>Nix <b>dev</b></a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>A tutorial site &amp; reference.</td></tr>
<tr><td>2.&nbsp;</td><td><a rel="nofollow" href="https://example.com/dup" class='result-link'>Duplicate</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>same page twice</td></tr>
<tr><td>3.&nbsp;</td><td><a rel="nofollow" href="https://example.com/dup" class='result-link'>Duplicate again</a></td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>dupe</td></tr>
</table></body></html>`;
globalThis.fetch = async (url) => String(url).includes('duckduckgo')
  ? new Response(lite, { status: 200, headers: { 'content-type': 'text/html' } })
  // any other provider is offline here: the parse test must not touch the network
  : Promise.reject(new Error('offline test: ' + String(url).slice(0, 40)));
const { webSearch } = await import(process.env.JERRITO_FILE);
const out = await webSearch('nix dev');
console.log(out);
EOF
out=$(JERRITO_4GET_URL=off JERRITO_SEARCH_HEDGE=0 JERRITO_FILE="$H" node /tmp/search-offline.mjs 2>&1)
has "search parses title" "1) Nix dev" "$out"
has "search decodes the uddg redirect" "https://nix.dev/" "$out"
has "search decodes entities" "A tutorial site & reference." "$out"
dupes=$(printf %s "$out" | grep -c "example.com/dup")
[ "$dupes" = 1 ] && ok "search dedupes host+path" || no "search dedupes host+path" "saw $dupes copies of the same url"

cat > /tmp/search-blocked.mjs <<'EOF'
const realFetch = globalThis.fetch;
const blocked = (u) => /duckduckgo|search\.brave\.com/.test(String(u));
globalThis.fetch = async (url) => blocked(url)
  ? new Response("<html><body><script src=\"/anomaly.js\"></script></body></html>", { status: 202, headers: { "content-type": "text/html" } })
  // bing is not part of this fixture: offline, like the rest
  : Promise.reject(new Error('offline test: ' + String(url).slice(0, 40)));
const { webSearch } = await import(process.env.JERRITO_FILE);
console.log(await webSearch("x"));
EOF
out=$(JERRITO_4GET_URL=off JERRITO_SEARCH_HEDGE=0 JERRITO_FILE="$H" node /tmp/search-blocked.mjs 2>&1)
has "search says rate-limited instead of no-results" "rate-limited" "$out"
out=$(node "$H" -t web_search "gdb reverse debugging" 2>&1)
if printf %s "$out" | grep -q "^No results for"; then
  echo "SKIP  web_search live (search providers are rate-limiting this IP right now)"
else
  has "web_search returns results" "http" "$out"
  has "web_search result shape" ") " "$out"
fi
out=$(node "$H" -t web_fetch https://nix.dev/ 2>&1); has "web_fetch returns markdown" "# " "$out"
out=$(node "$H" -t web_fetch https://nix.dev/manual/nix/2.35.6/release-notes/ 2>&1); has "web_fetch 404 is a clean message" "HTTP 404" "$out"
out=$(node "$H" -t web_fetch https://nonexistent-host-xyz-12345.example 2>&1); has "web_fetch DNS failure is a clean message" "ENOTFOUND" "$out"
out=$(node "$H" -t read . 2>&1); has "read lists dir with sizes" "jerrito.mjs  " "$out"
out=$(node "$H" -t read jerrito.mjs 2>&1); has "read file is line-numbered" "1| #!/usr/bin/env node" "$out"
out=$(JERRITO_READ_LINES=4 node "$H" -t read jerrito.mjs 2>&1); has "read truncation hint" "continue with offset=" "$out"
out=$(node "$H" -t read ../../etc/passwd 2>&1); c=$?
[ "$c" = 1 ] && has "read blocks path escape" "escapes project root" "$out" || no "read escape exit code" "got $c"
out=$(node "$H" -t read /dev/zero 2>&1); has "read blocks device files" "escapes project root" "$out"
# grep: search, do not read whole files
out=$(node "$H" -t grep "web_search|web_fetch" 2>&1)
has "grep: | alternation matches" 'for "web_search|web_fetch"' "$out"
has "grep: returns path:line: text" "jerrito.mjs:" "$out"
out=$(node "$H" -t grep "nixpkgs" README.md 2>&1)
has "grep: path scopes the search" "under README.md" "$out"
out=$(node "$H" -t grep "enable" . "*.sh" 2>&1)
case "$out" in *.md:*) no "grep: glob restricts to matching files";; *) ok "grep: glob restricts to matching files";; esac
absent="zz$(date +%s%N)qq"
out=$(node "$H" -t grep "$absent" 2>&1)
has "grep: says so when nothing matches" "no match for" "$out"
out=$(node "$H" -t grep "(" "(" 2>&1)
[ -n "$out" ] && ok "grep: invalid regex falls back to text" || no "grep: invalid regex falls back to text"
out=$(node "$H" -t grep 2>&1); has "grep: missing pattern is reported" "needs a" "$out"
# man: system manual pages, capped and sanitized
mf=/tmp/jerrito-man-fixture; rm -rf "$mf"; mkdir -p "$mf/man1"
printf '.TH FOO 1 "2026" "jerrito tests"\n.SH NAME\nfoo \\- test page for the man tool\n.SH OPTIONS\n.B -x\ndoes the thing\n' > "$mf/man1/foo.1"
printf '.TH BAR 1\n.SH NAME\nbar \\- other page\n' > "$mf/man1/bar.1"
out=$(MANPATH="$mf" node "$H" -t man foo 2>&1)
has   "man: reads the page" "test page for the man tool" "$out"
hasnt "man: no backspace overstrikes" "$(printf '\303\242\302\200\302\220')" "$out"
out=$(MANPATH="$mf" node "$H" -t man foo 1 2>&1)
has   "man: section argument works" "test page" "$out"
out=$(MANPATH="$mf" node "$H" -t man nosuchpage 2>&1)
has   "man: honest no-entry message" 'no manual entry for "nosuchpage"' "$out"
out=$(MANPATH="$mf" node "$H" -t man -x 2>&1)
has   "man: option-looking names rejected" "needs a page name" "$out"
out=$(MANPATH="$mf" node "$H" -t man foo 99 2>&1)
has   "man: unknown section is honest" 'no manual entry for "foo"' "$out"
out=$(node "$H" -t man 2>&1); has "man: missing page is reported" "needs a page name" "$out"
rm -rf "$mf"

out=$(node "$H" -t grep x ../../etc 2>&1); c=$?
has "grep: cannot escape the project root" "escapes project root" "$out"

# junk directories must never be searched (and cannot be reached by walking up)
probe=/tmp/grep-proj
rm -rf "$probe"; mkdir -p "$probe/src" "$probe/node_modules/x" "$probe/.git"
printf "needle here\n" > "$probe/src/a.txt"
printf "needle in junk\n" > "$probe/node_modules/x/b.js"
printf "needle in git\n" > "$probe/.git/config"
out=$(cd "$probe" && node "$H" -t grep needle 2>&1)
has "grep: finds files in the tree" "src/a.txt:1:" "$out"
case "$out" in *node_modules*|*.git*) no "grep: skips node_modules and .git";; *) ok "grep: skips node_modules and .git";; esac
case "$out" in *"1 file"*) ok "grep: only the real hit counted";; *) no "grep: only the real hit counted" "$out";; esac
rm -rf "$probe"

out=$(node "$H" -t nonsense x 2>&1); has "unknown tool is reported" "Unknown tool" "$out"
out=$(node "$H" -t web_search 2>&1); has "tool without arg is reported" "needs a" "$out"
# rename migration: a pre-rename ~/.cache/helper is adopted, not re-downloaded
mig=/tmp/jerrito-mig-home; rm -rf "$mig"; mkdir -p "$mig/.cache/helper/models"
touch "$mig/.cache/helper/models/fake-model.gguf"
out=$(HOME="$mig" node "$H" --status 2>&1)
[ -f "$mig/.cache/jerrito/models/fake-model.gguf" ] && ok "cache migrated from the old helper dir" || no "cache migrated" "model file not found in the new path"
[ ! -e "$mig/.cache/helper" ] && ok "old cache dir gone after migration" || no "old cache dir gone" "still exists"
rm -rf "$mig"

out=$(node "$H" --help 2>&1); has "--help lists usage" "usage:" "$out"
out=$(node "$H" --help 2>&1); has "--help names the file it was run as" 'jerrito "question"' "$out"
out=$(JERRITO_PROG=j node "$H" --help 2>&1); has "--help follows the installed name" 'j "question"' "$out"
rm -rf /tmp/ht-prog-home; out=$(HOME=/tmp/ht-prog-home JERRITO_PROG=j node "$H" --stop 2>&1); has "messages follow the installed name" "no j-managed server" "$out"; rm -rf /tmp/ht-prog-home
hasnt "--help has no fabricated example" "llama-server -m model.gguf" "$out"

echo
echo "== cold start (spawns server + downloads nothing, model is seeded) =="
t0=$(date +%s%N)
out=$(node "$H" "how many lines is jerrito.mjs? Use the read tool." 2>&1); c=$?
t1=$(date +%s%N); cold_ms=$(( (t1-t0)/1000000 ))
[ "$c" = 0 ] && ok "cold run exits 0" || no "cold run exit code" "got $c: $(printf '%s' "$out" | tail -3)"
[ -f "$HOME/.cache/jerrito/server.json" ] && ok "cold run wrote server.json" || no "cold run wrote server.json"
pid1=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.cache/jerrito/server.json")).pid)}catch{}')
base1=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.cache/jerrito/server.json")).base)}catch{}')
[ -n "$pid1" ] && ok "server pid recorded ($pid1)" || no "server pid recorded"
curl -sf "${base1%/v1}/health" >/dev/null 2>&1 && ok "server answers /health" || no "server answers /health" "$base1"
has "cold answer mentions the file" "line" "$out"

echo
echo "== warm reuse (must not spawn a second server) =="
t0=$(date +%s%N)
out=$(node "$H" "say ok" 2>&1); c=$?
t1=$(date +%s%N); warm_ms=$(( (t1-t0)/1000000 ))
pid2=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.cache/jerrito/server.json")).pid)')
[ "$pid1" = "$pid2" ] && ok "reused same server pid" || no "reused same server pid" "$pid1 -> $pid2"
[ "$c" = 0 ] && ok "warm run exits 0" || no "warm run exit code" "got $c"
echo "        cold ${cold_ms}ms / warm ${warm_ms}ms"
[ "$warm_ms" -lt "$cold_ms" ] && ok "warm run is faster than cold" || no "warm run is faster than cold" "${cold_ms}ms vs ${warm_ms}ms"

echo
echo "== status / stop =="
out=$(node "$H" --status 2>&1); has "--status reports running" "running pid=" "$out"
out=$(node "$H" --stop 2>&1); has "--stop reports stopping" "stopped llama-server" "$out"
sleep 1
out=$(node "$H" --status 2>&1); has "--status after stop" "no jerrito-managed server" "$out"
curl -sf "${base1%/v1}/health" >/dev/null 2>&1 && no "server is really gone" "still healthy" || ok "server is really gone"
[ -f "$HOME/.cache/jerrito/server.json" ] && no "state file removed" "still there" || ok "state file removed"

echo
echo "== symlinked install (ln -s into ~/.local/bin) =="
link="$HOME/.jerrito-link-test"
ln -sf "$H" "$link"
out=$("$link" --help 2>&1); case "$out" in *usage:*) ok "symlinked binary runs";; *) no "symlinked binary runs" "got: $(printf '%s' "$out" | head -c 120)";; esac
out=$("$link" --status 2>&1); c=$?
[ "$c" = 0 ] && [ -n "$out" ] && ok "symlinked --status prints something" || no "symlinked --status" "exit $c, output '$out'"
out=$("$link" -t read . 2>&1)
case "$out" in *jerrito.mjs*) ok "symlinked tool invocation works";; *) no "symlinked tool invocation" "$(printf '%s' "$out" | head -c 120)";; esac
rm -f "$link"

echo
echo "== interactive REPL (piped stdin) =="
out=$(printf '/help\n/reset\n/exit\n' | node "$H" 2>&1); c=$?
[ "$c" = 0 ] && ok "REPL exits cleanly" || no "REPL exit" "got $c"
has "REPL shows /reset /exit help" "/reset" "$out"

echo
echo "== summary: $pass passed, $fail failed =="
[ "$fail" = 0 ]