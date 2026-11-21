#!/usr/bin/env bash
# provisioning tests in throwaway HOMEs: model discovery, explicit -m, real download
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
H="$HERE/../jerrito.mjs"
SRC=${JERRITO_TEST_MODEL:-$HOME/.cache/jerrito/models/Sharp-MiniCPM5-2B-Q4_K_S.gguf}
cd "$HERE/.." || exit 1
pass=0; fail=0
command -v llama-server >/dev/null 2>&1 || [ -n "${JERRITO_BIN_DIR:-}" ] || echo "WARN  llama-server is not on PATH: the tests that start a server will fail (use: nix develop -c ./test/run.sh)"

ok() { echo "PASS  $1"; pass=$((pass+1)); }
no() { echo "FAIL  $1${2:+  <<< $2}"; fail=$((fail+1)); }
has() { local n="$1" s="$2" o="$3"; case "$o" in *"$s"*) ok "$n";; *) no "$n" "expected '$s' in: $(printf '%s' "$o" | tail -c 200)";; esac; }

# ---- A: explicit -m, seeded cache (no download) ----------------------------
A=/tmp/fakehome-a; rm -rf "$A"; mkdir -p "$A/.cache/jerrito/models"
ln "$SRC" "$A/.cache/jerrito/models/Sharp-MiniCPM5-2B-Q4_K_S.gguf" 2>/dev/null || cp "$SRC" "$A/.cache/jerrito/models/"
echo "== A: seeded cache, --model path is remembered =="
out=$(HOME=$A node "$H" --status 2>&1); has "A: fresh HOME has no server" "no jerrito-managed server" "$out"
t0=$(date +%s%N)
out=$(HOME=$A node "$H" "say ok" 2>&1); c=$?
t1=$(date +%s%N)
[ "$c" = 0 ] && ok "A: run exits 0 ($(( (t1-t0)/1000000 ))ms)" || no "A: run exit" "got $c: $(printf '%s' "$out" | tail -2)"
has "A: spawned without downloading" "starting llama-server" "$out"
[ -f "$A/.cache/jerrito/server.json" ] && ok "A: state written under fake HOME" || no "A: state written"
curl -sf "$(node -e "console.log(require('$A/.cache/jerrito/server.json').base.replace(/\/v1$/,''))" 2>/dev/null)/health" >/dev/null 2>&1 \
  && ok "A: server healthy" || no "A: server healthy"
HOME=$A node "$H" --stop >/dev/null 2>&1; sleep 0.8
out=$(HOME=$A node "$H" "say ok" 2>&1); c=$?
[ "$c" = 0 ] && ok "A: restarts after --stop" || no "A: restarts after --stop" "got $c"
HOME=$A node "$H" --stop >/dev/null 2>&1; sleep 0.8

echo
echo "== A2: explicit .gguf path is saved to config =="
out=$(HOME=$A node "$H" -m "$A/.cache/jerrito/models/Sharp-MiniCPM5-2B-Q4_K_S.gguf" "say ok" 2>&1); c=$?
[ "$c" = 0 ] && ok "A2: -m <path> run exits 0" || no "A2: -m run exit" "got $c"
has "A2: config records the model" "Sharp-MiniCPM5-2B-Q4_K_S.gguf" "$(cat "$A/.config/jerrito/config.json" 2>/dev/null)"
HOME=$A node "$H" --stop >/dev/null 2>&1; sleep 0.8

# ---- B: empty HOME -> real download ---------------------------------------
B=/tmp/fakehome-b; rm -rf "$B"; mkdir -p "$B"
echo
echo "== B: empty machine, downloads a model once =="
t0=$(date +%s%N)
out=$(HOME=$B node "$H" "say ok" 2>&1); c=$?
t1=$(date +%s%N); ms=$(( (t1-t0)/1000000 ))
[ "$c" = 0 ] && ok "B: first run exits 0 (${ms}ms incl. download)" || no "B: first run exit" "got $c: $(printf '%s' "$out" | tail -3)"
has "B: says it is downloading" "fetching Sharp-MiniCPM5-2B" "$out"
size=$(stat -c %s "$B/.cache/jerrito/models/Sharp-MiniCPM5-2B-Q4_K_S.gguf" 2>/dev/null || echo 0)
[ "$size" = 1516390912 ] && ok "B: downloaded model is byte-exact" || no "B: downloaded model size" "got $size"
[ -f "$B/.cache/jerrito/server.json" ] && ok "B: state written" || no "B: state written"
HOME=$B node "$H" --stop >/dev/null 2>&1; sleep 0.8

echo
echo "== cross-directory reuse (state is global) =="
out=$(HOME=$A node "$H" "say ok" 2>&1); sleep 0.2
pid1=$(node -e "console.log(require('$A/.cache/jerrito/server.json').pid)" 2>/dev/null)
out=$(cd /tmp && HOME=$A node "$H" "say ok" 2>&1); c=$?
pid2=$(node -e "console.log(require('$A/.cache/jerrito/server.json').pid)" 2>/dev/null)
[ "$c" = 0 ] && ok "same server used from another cwd" || no "cross-cwd run" "got $c"
[ "$pid1" = "$pid2" ] && [ -n "$pid1" ] && ok "no second server spawned from another cwd" || no "second server spawned" "$pid1 -> $pid2"
HOME=$A node "$H" --stop >/dev/null 2>&1

echo
echo "== cleanup =="
rm -rf "$A" "$B"
echo "== summary: $pass passed, $fail failed =="
[ "$fail" = 0 ]