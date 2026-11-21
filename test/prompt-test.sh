#!/usr/bin/env bash
# The system prompt: instanced per invocation, mode-aware, never loaded from a
# stale copy, never persisted. Offline (a stub server records what it receives).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
H="$HERE/../jerrito.mjs"
cd "$HERE/.." || exit 1
MP=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{const p=s.address().port;console.log(p);s.close()})')
export MOCK_PORT=$MP
LOG=/tmp/prompt-log.jsonl
BASE=http://127.0.0.1:$MP/v1
pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass+1)); }
no() { echo "FAIL  $1${2:+  <<< $2}"; fail=$((fail+1)); }
has() { local n="$1" s="$2" o="$3"; case "$o" in *"$s"*) ok "$n";; *) no "$n" "expected '$s' in: $(printf '%s' "$o" | head -c 170)";; esac; }
hasnt() { local n="$1" s="$2" o="$3"; case "$o" in *"$s"*) no "$n" "unexpected '$s'";; *) ok "$n";; esac; }

cat > /tmp/mock-prompt.mjs <<'MOCK'
import http from 'node:http';
import fs from 'node:fs';
const LOG = '/tmp/prompt-log.jsonl';
http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', data: [{ id: 'mock' }] }));
  }
  const j = JSON.parse(body || '{}');
  const msgs = j.messages || [];
  const sys = (msgs.find((m) => m.role === 'system') || {}).content || '';
  const user = (msgs.find((m) => m.role === 'user') || {}).content || '';
  fs.appendFileSync(LOG, JSON.stringify({ sys, user, tools: Array.isArray(j.tools) ? j.tools.length : 0 }) + '\n');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const text = /ask back/i.test(user) ? 'Want me to continue?' : 'ok';
  res.write('data: ' + JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { content: text } }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}).listen(Number(process.env.MOCK_PORT), '127.0.0.1');
MOCK

node /tmp/mock-prompt.mjs & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
for i in $(seq 1 50); do curl -sf "${BASE%/v1}/models" >/dev/null 2>&1 && break; sleep 0.2; done

run1() { timeout 30 env JERRITO_BASE_URL="$BASE" node "$H" "$1" 2>&1; }
last() { node -e 'const l=require("fs").readFileSync(process.env.LOG,"utf8").trim().split("\n");const j=JSON.parse(l[l.length-1]);console.log(j[process.argv[1]])' "$1"; }

echo "== one-shot mode (auto-detected: a question argument) =="
rm -f "$LOG"
out=$(run1 "plain question")
sys=$(LOG="$LOG" last sys)
has   "prompt says there is no next turn" "no next turn" "$sys"
hasnt "prompt does not claim an interactive session" "interactive shell" "$sys"
has   "prompt forbids asking back" "never ask a question" "$sys"
has   "prompt forbids offering more" "never offer to do more" "$sys"
has   "prompt is dated today" "$(date +%F)" "$sys"
has   "prompt says the host and user" "$(id -un)@$(hostname)" "$sys"
has   "prompt says the distro" "$(. /etc/os-release 2>/dev/null; echo $PRETTY_NAME)" "$sys"
has   "prompt says the shell" "$(basename "${SHELL:-sh}")" "$sys"
has   "prompt warns against foreign package managers" "not apt/dnf/pip" "$sys"
has   "prompt names the project root (cwd)" "$PWD" "$sys"
has   "prompt lists the top level of that root" "jerrito.mjs" "$sys"
has   "prompt names read" "read only the lines" "$sys"
has   "prompt names grep" "grep first" "$sys"
has   "prompt names web_search" "web_search" "$sys"
has   "prompt names web_fetch" "web_fetch" "$sys"
has   "prompt forbids running commands" "cannot run shell commands" "$sys"
has   "prompt demands a source" "Say where an answer came from" "$sys"
has   "prompt warns training data is stale" "training data is older than today" "$sys"
has   "prompt ends with the answer rule" "End with the answer" "$sys"
has   "prompt forbids repeat tool calls" "Do not call a tool twice with the same arguments" "$sys"
tools=$(LOG="$LOG" last tools)
[ "$tools" = 4 ] && ok "request carries the 4 tool schemas" || no "request carries 4 tool schemas" "got $tools"
size=${#sys}
[ "$size" -lt 2000 ] && ok "prompt stays small ($size chars)" || no "prompt stays small" "$size chars"

echo
echo "== interactive mode (auto-detected: no question argument) =="
rm -f "$LOG"
printf 'plain question\n/exit\n' | timeout 30 env JERRITO_BASE_URL="$BASE" node "$H" >/dev/null 2>&1
sys=$(LOG="$LOG" last sys)
has   "repl prompt says the user can reply" "interactive shell" "$sys"
has   "repl prompt mentions earlier turns" "earlier turns are above" "$sys"
hasnt "repl prompt has no one-shot wording" "no next turn" "$sys"

echo
echo "== instanced per invocation, from current state =="
other=/tmp/prompt-project
rm -rf "$other"; mkdir -p "$other"; touch "$other/marker.txt"
rm -f "$LOG"
( cd "$other" && timeout 30 env JERRITO_BASE_URL="$BASE" node "$H" "plain question" >/dev/null 2>&1 )
sys=$(LOG="$LOG" last sys)
has   "prompt picks up the new cwd as root" "$other" "$sys"
has   "prompt lists that directory" "marker.txt" "$sys"
hasnt "prompt does not leak the previous root" "$PWD/jerrito.mjs" "$sys"
rm -rf "$other"

echo
echo "== one prompt definition, nothing persisted, none in tool mode =="
n=$(grep -c 'You are "jerrito"' "$H")
[ "$n" = 1 ] && ok "exactly one prompt definition in the source" || no "one prompt definition" "found $n"
for f in "$HOME/.config/jerrito/config.json" "$HOME/.cache/jerrito/server.json"; do
  if [ -f "$f" ] && grep -q 'You are' "$f"; then no "no prompt text in $(basename "$f")"; else ok "no prompt text in $(basename "$f")"; fi
done
rm -f "$LOG"
timeout 30 node "$H" -t read . >/dev/null 2>&1
[ ! -s "$LOG" ] && ok "tool mode builds no prompt (no model call)" || no "tool mode made a model call"

echo
echo "== the running copy identifies itself (stale-build trap) =="
H_REAL="$(cd "$HERE/.." && pwd)/jerrito.mjs"
out=$(node "$H" --status 2>&1)
has "live tree: --status prints its own source" "source  $H_REAL" "$out"
hasnt "live tree: not marked frozen" "frozen build" "$out"
cp "$H" /tmp/jerrito-copy.mjs
out=$(node /tmp/jerrito-copy.mjs --status 2>&1)
has "a copy reports its own path, not the original" "source  /tmp/jerrito-copy.mjs" "$out"
rm -f /tmp/jerrito-copy.mjs

echo
echo "== one-shot hint when the model asks back =="
out=$(run1 "ask back")
has "hint points at the session mode" "(one-shot answer" "$out"

echo
echo "== summary: $pass passed, $fail failed =="
[ "$fail" = 0 ]