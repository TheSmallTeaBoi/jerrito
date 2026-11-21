#!/usr/bin/env bash
# Run all jerrito tests.
#   ./test/run.sh              everything (~3-5 min, incl. a 1.5 GB model download)
#   SKIP_DOWNLOAD=1 ...        skip the download test (~40 s)
#   JERRITO_TEST_MODEL=...      use a specific .gguf for the seeded-cache tests
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE" || exit 1
fail=0

if ! command -v llama-server >/dev/null 2>&1 && [ -z "${JERRITO_BIN_DIR:-}" ]; then
  echo "llama-server is not on PATH — the tests that start a server cannot run."
  echo "  nix develop -c ./test/run.sh        (this repo has a flake)"
  echo "  JERRITO_BIN_DIR=/path/to/bin ./test/run.sh"
  exit 1
fi

run() {
  echo
  echo "################ $1"
  if ! bash "$HERE/$1.sh"; then fail=$((fail+1)); fi
}

# cheap, no model: tools, lifecycle, agent loop, rendering against mock servers
run jerrito-tests
run agent-tests
run render-test
run fetch-test
run prompt-test
run instances-test
# real model: spawn/reuse, SIGINT, concurrency
run concurrency-test
run abort-test
# provisioning (downloads a model if SKIP_DOWNLOAD is not set)
if [ "${SKIP_DOWNLOAD:-0}" = 1 ]; then
  echo
  echo "################ provision-tests (skipped: SKIP_DOWNLOAD=1)"
else
  run provision-tests
fi

echo
[ "$fail" = 0 ] && echo "ALL SUITES PASSED" || echo "$fail SUITE(S) FAILED"
[ "$fail" = 0 ]