#!/usr/bin/env bash
# concurrency: two jerritos starting at the same moment must share one server
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
H="$HERE/../jerrito.mjs"
cd "$HERE/.." || exit 1
pass=0; fail=0
command -v llama-server >/dev/null 2>&1 || [ -n "${JERRITO_BIN_DIR:-}" ] || echo "WARN  llama-server is not on PATH: the tests that start a server will fail (use: nix develop -c ./test/run.sh)"

ok() { echo "PASS  $1"; pass=$((pass+1)); }
no() { echo "FAIL  $1${2:+  <<< $2}"; fail=$((fail+1)); }

node "$H" --stop >/dev/null 2>&1; sleep 1
rm -f "$HOME/.cache/jerrito/server.json" "$HOME/.cache/jerrito/server.lock"

before=$(pgrep -fc 'llama-server -m .*Sharp-MiniCPM5' || true)
echo "llama-servers before: ${before:-0}"

node "$H" "say alpha" >/tmp/par1.out 2>&1 & p1=$!
node "$H" "say beta"  >/tmp/par2.out 2>&1 & p2=$!
wait $p1; c1=$?
wait $p2; c2=$?
[ "$c1" = 0 ] && ok "parallel run 1 exits 0" || no "parallel run 1 exit" "got $c1: $(tail -2 /tmp/par1.out)"
[ "$c2" = 0 ] && ok "parallel run 2 exits 0" || no "parallel run 2 exit" "got $c2: $(tail -2 /tmp/par2.out)"

sleep 1
n=$(pgrep -fc 'llama-server -m .*Sharp-MiniCPM5' || true)
[ "${n:-0}" = 1 ] && ok "exactly one jerrito server running (got $n)" || no "server count" "expected 1, got ${n:-0}"
pid_state=$(node -e 'try{console.log(require(process.env.HOME+"/.cache/jerrito/server.json").pid)}catch{}')
[ -n "$pid_state" ] && ok "state file has a pid ($pid_state)" || no "state file pid"
[ -f "$HOME/.cache/jerrito/server.lock" ] && no "lock released" "lock file still present" || ok "lock released"

node "$H" --stop >/dev/null 2>&1; sleep 1
n=$(pgrep -fc 'llama-server -m .*Sharp-MiniCPM5' || true)
[ "${n:-0}" = 0 ] && ok "--stop cleans up (0 servers)" || no "--stop left servers" "got ${n:-0}"

# a busy (generating) server must be reused: /health does not answer mid-answer
# on a single-slot server, and a second jerrito must not kill or duplicate it
echo
echo "== busy server must not be killed or duplicated =="
node "$H" "say ready" >/dev/null 2>&1
pid_before=$(pgrep -f 'llama-server -m .*Sharp-MiniCPM5' | head -1)
[ -n "$pid_before" ] && ok "server up before busy test" || no "server up before busy test"
node "$H" "write a 200 word essay about nix flakes" >/tmp/busy.out 2>&1 & busy=$!
sleep 2
out=$(node "$H" --status 2>&1)
case "$out" in *running*) ok "--status reports running while busy";; *) no "--status while busy" "$out";; esac
out=$(node "$H" "say ok" 2>&1); c=$?
wait $busy; cb=$?
[ "$c" = 0 ] && ok "second jerrito answered while server busy" || no "second jerrito while busy" "exit $c: $(printf '%s' "$out" | tail -2)"
[ "$cb" = 0 ] && ok "first (long) jerrito still answered" || no "long jerrito" "exit $cb"
pid_after=$(pgrep -f 'llama-server -m .*Sharp-MiniCPM5' | head -1)
count=$(pgrep -fc 'llama-server -m .*Sharp-MiniCPM5' || echo 0)
[ "$pid_before" = "$pid_after" ] && ok "same server pid after busy test" || no "pid changed" "$pid_before -> $pid_after"
[ "${count:-0}" = 1 ] && ok "still exactly one server" || no "server count after busy test" "got ${count:-0}"
node "$H" --stop >/dev/null 2>&1

echo
echo "== summary: $pass passed, $fail failed =="
[ "$fail" = 0 ]