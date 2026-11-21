#!/usr/bin/env bash
# SIGINT during generation must abort cleanly, not hang or crash
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
H="$HERE/../helper.mjs"
cd "$HERE/.." || exit 1
pass=0; fail=0
command -v llama-server >/dev/null 2>&1 || [ -n "${HELPER_BIN_DIR:-}" ] || echo "WARN  llama-server is not on PATH: the tests that start a server will fail (use: nix develop -c ./test/run.sh)"

ok() { echo "PASS  $1"; pass=$((pass+1)); }
no() { echo "FAIL  $1${2:+  <<< $2}"; fail=$((fail+1)); }

node "$H" "say ok" >/dev/null 2>&1   # warm the server first

out=$(mktemp)
node "$H" "write 300 words about nix flakes" >"$out" 2>&1 &
pid=$!
sleep 3
kill -INT "$pid" 2>/dev/null
wait "$pid"; c=$?
body=$(cat "$out"); rm -f "$out"
[ "$c" = 1 ] && ok "SIGINT mid-generation exits 1" || no "SIGINT exit code" "got $c"
case "$body" in *aborted*) ok "SIGINT prints 'aborted'";; *) no "SIGINT message" "$(printf '%s' "$body" | tail -c 150)";; esac
case "$body" in *"Unhandled"*|*"ERR_"*) no "SIGINT leaves no crash trace" "$(printf '%s' "$body" | tail -c 150)";; *) ok "SIGINT leaves no crash trace";; esac

node "$H" --stop >/dev/null 2>&1
echo
echo "== summary: $pass passed, $fail failed =="
[ "$fail" = 0 ]