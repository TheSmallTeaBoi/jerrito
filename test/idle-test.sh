#!/usr/bin/env bash
# idle + VRAM tests — the server must not squat on the GPU forever.
#   * serverArgs passes --sleep-idle-seconds only when the build knows it
#   * the watchdog's decision (underPressure) without a GPU
#   * a real spawned watchdog against a fake llama-server: it kills an idle
#     server when VRAM is short, and leaves it alone otherwise
# No model, no GPU, no network.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
H="$HERE/../jerrito.mjs"
cd "$HERE/.." || exit 1
pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass+1)); }
no() { echo "FAIL  $1${2:+  <<< $2}"; fail=$((fail+1)); }
has() { local n="$1" s="$2" o="$3"; case "$o" in *"$s"*) ok "$n";; *) no "$n" "expected '$s' in: $(printf '%s' "$o" | tail -c 220)";; esac; }
hasnt() { local n="$1" s="$2" o="$3"; case "$o" in *"$s"*) no "$n" "unexpected '$s'";; *) ok "$n";; esac; }
alive() { kill -0 "$1" 2>/dev/null; }
# count runs in the current shell (process substitution, not a pipe): a pipe
# would put the pass/fail counters in a subshell and lose them
# a node helper that prints PASS/FAIL lines: count them into the totals
count() { local line; while IFS= read -r line; do case "$line" in PASS\ *) ok "${line#PASS  }";; FAIL\ *) no "${line#FAIL  }";; "") ;; *) echo "$line";; esac; done; }
state() { HOME="$1" node -e 'try{console.log(JSON.parse(require("node:fs").readFileSync(process.env.HOME+"/.cache/jerrito/server.json")).'"$2"')}catch{}'; }

job=$(mktemp -d /tmp/jerrito-idle.XXXXXX)
# every fake server records its pid here, so cleanup cannot miss one even if a
# case failed halfway (a stray llama-server on the GPU would poison the next run)
cleanup() {
  local p
  for p in $(cat "$job/pids" 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
  pkill -9 -f "$job/bin/llama-server" 2>/dev/null
  rm -rf "$job"
}
trap cleanup EXIT

echo "== the decision, without a GPU =="
cat > /tmp/idle-unit.mjs <<'UNIT'
const m = await import(process.env.JERRITO_FILE);
const mb = (n) => n * 2 ** 20;
const cases = [
  ['pressure + quiet',               m.underPressure({ freeBytes: mb(100), floorBytes: mb(700), idleMs: 120000, graceMs: 60000 }), true],
  ['pressure but busy',              m.underPressure({ freeBytes: mb(100), floorBytes: mb(700), idleMs: 120000, graceMs: 60000, processing: true }), false],
  ['pressure but just used',         m.underPressure({ freeBytes: mb(100), floorBytes: mb(700), idleMs: 5000, graceMs: 60000 }), false],
  ['room to spare',                  m.underPressure({ freeBytes: mb(3000), floorBytes: mb(700), idleMs: 120000, graceMs: 60000 }), false],
  ['no way to read VRAM',            m.underPressure({ freeBytes: null, floorBytes: mb(700), idleMs: 120000, graceMs: 60000 }), false],
  ['grace 0 acts on the first poll', m.underPressure({ freeBytes: mb(100), floorBytes: mb(700), idleMs: 0, graceMs: 0 }), true],
];
for (const [name, got, want] of cases) {
  console.log(`${got === want ? 'PASS' : 'FAIL'}  underPressure: ${name}${got === want ? '' : ` (got ${got})`}`);
}

// serverArgs: the flag only goes to a build that has it, and 0 disables it
const flagOf = (args) => { const i = args.indexOf('--sleep-idle-seconds'); return i < 0 ? null : args[i + 1]; };
const withIdle = (caps, env) => {
  const old = process.env.JERRITO_IDLE;
  if (env === undefined) delete process.env.JERRITO_IDLE; else process.env.JERRITO_IDLE = env;
  const args = m.serverArgs('/tmp/m.gguf', 1234, false, caps);
  if (old === undefined) delete process.env.JERRITO_IDLE; else process.env.JERRITO_IDLE = old;
  return args;
};
const expect = (name, got, want) => console.log(`${String(got) === String(want) ? 'PASS' : 'FAIL'}  ${name}${String(got) === String(want) ? '' : ` (got ${got}, wanted ${want})`}`);
expect('serverArgs: JERRITO_IDLE=42 becomes the flag', flagOf(withIdle({ sleepIdle: true }, '42')), '42');
expect('serverArgs: default idle is 300s', flagOf(withIdle({ sleepIdle: true })), '300');
expect('serverArgs: JERRITO_IDLE=0 means never', flagOf(withIdle({ sleepIdle: true }, '0')), null);
expect('serverArgs: an old build does not get the flag', flagOf(withIdle({ sleepIdle: false }, '42')), null);

const v = m.vramFreeBytes();
expect('vramFreeBytes honours JERRITO_VRAM_FREE_MB', v, 1234 * 2 ** 20);
UNIT
count < <(HOME="$job/home" JERRITO_VRAM_FREE_MB=1234 JERRITO_FILE="$H" node /tmp/idle-unit.mjs 2>&1)

echo
echo "== fake llama-server (records its argv, serves llama.cpp's API) =="
mkdir -p "$job/bin" "$job/home"
cat > "$job/bin/llama-server" <<'FAKE'
#!/usr/bin/env node
// minimal llama-server: enough of the API for a jerrito one-shot, plus argv capture
import http from 'node:http';
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  console.log('fake llama-server');
  // FAKE_OLD_BUILD=1 imitates an older llama.cpp that has no idle sleeping
  if (process.env.FAKE_OLD_BUILD !== '1') console.log('  --sleep-idle-seconds SECONDS   sleep when idle');
  process.exit(0);
}
const port = Number(argv[argv.indexOf('--port') + 1]);
appendFileSync(process.env.HOME + '/fake-argv.log', argv.join(' ') + '\n');
if (process.env.FAKE_PIDFILE) appendFileSync(process.env.FAKE_PIDFILE, process.pid + '\n');
console.log('fake server on ' + port);      // startup output is the log's first activity
http.createServer((req, res) => {
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/health') return json({ status: 'ok' });
  // the fake is "generating" when the test says so: the watchdog must not kill it
  if (req.url === '/slots') return json([{ id: 0, n_ctx: 4096, is_processing: process.env.FAKE_BUSY === '1' }]);
  if (req.url.endsWith('/models')) return json({ data: [{ id: 'fake' }] });
  if (req.url.endsWith('/chat/completions')) {
    return json({ choices: [{ message: { role: 'assistant', content: 'fake answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1');
FAKE
chmod +x "$job/bin/llama-server"

# one jerrito run against the fake: its own HOME (state + log), no real GPU
runj() {
  HOME="$1" JERRITO_BIN_DIR="$job/bin" JERRITO_MODEL_FILE="$job/fake-qwen3.gguf" JERRITO_4GET_URL=off \
    FAKE_PIDFILE="$job/pids" timeout 40 env $2 node "$H" "say ok" 2>&1
}
stopj() { HOME="$1" node "$H" --stop >/dev/null 2>&1; pkill -f "$job/bin/llama-server" 2>/dev/null; sleep 0.5; }

h1="$job/h1"; mkdir -p "$h1"
out=$(runj "$h1" "JERRITO_IDLE=7 JERRITO_NO_WATCHDOG=1"); c=$?
[ "$c" = 0 ] && has "one-shot against the fake works" "fake answer" "$out" || no "one-shot against the fake" "$out"
argvs=$(cat "$h1/fake-argv.log" 2>/dev/null)
has "server args carry --sleep-idle-seconds 7" "--sleep-idle-seconds 7" "$argvs"
has "server args keep --jinja" "--jinja" "$argvs"
out=$(HOME="$h1" JERRITO_NO_WATCHDOG=1 JERRITO_BIN_DIR="$job/bin" JERRITO_MODEL_FILE="$job/m.gguf" node "$H" --status 2>&1)
has "--status reports the idle policy" "sleeps after 7s idle" "$out"
stopj "$h1"

h2="$job/h2"; mkdir -p "$h2"
runj "$h2" "JERRITO_IDLE=0 JERRITO_NO_WATCHDOG=1" >/dev/null
hasnt "JERRITO_IDLE=0 passes no sleep flag" "--sleep-idle-seconds" "$(cat "$h2/fake-argv.log" 2>/dev/null)"
stopj "$h2"

h3="$job/h3"; mkdir -p "$h3"
out=$(runj "$h3" "JERRITO_IDLE=7 JERRITO_NO_WATCHDOG=1 FAKE_OLD_BUILD=1")
hasnt "an old llama-server build is not given the flag" "--sleep-idle-seconds" "$(cat "$h3/fake-argv.log" 2>/dev/null)"
has "an old build still starts and answers" "fake answer" "$out"
stopj "$h3"

echo
echo "== watchdog: an idle server gets out of the way =="
# 100 MB free is below the 700 MB floor and the grace is 0, so the first poll
# (~5 s) should kill it
h4="$job/h4"; mkdir -p "$h4"
runj "$h4" "JERRITO_VRAM_FREE_MB=100 JERRITO_VRAM_GRACE=0" >/dev/null
pid=$(state "$h4" pid); watch=$(state "$h4" watchPid)
[ -n "$watch" ] && ok "a watchdog was started (pid $watch)" || no "a watchdog was started" "no watchPid in server.json"
killed=no
for i in $(seq 1 14); do sleep 1; alive "$pid" || { killed=yes; break; }; done
[ "$killed" = yes ] && ok "watchdog killed the idle server under pressure" || no "watchdog killed the idle server under pressure" "pid $pid still alive"
[ -f "$h4/.cache/jerrito/server.json" ] && no "state file removed after the kill" "still there" || ok "state file removed after the kill"
has "watchdog log says what it did" "killed llama-server" "$(cat "$h4/.cache/jerrito/watchdog.log" 2>/dev/null)"
has "watchdog log names the pressure" "MB VRAM free" "$(cat "$h4/.cache/jerrito/watchdog.log" 2>/dev/null)"
sleep 1
alive "$watch" && no "watchdog exits after the kill" "still running" || ok "watchdog exits after the kill"

echo
echo "== watchdog: nothing to do, so it does nothing =="
# plenty of VRAM: the floor is not crossed, the server must be left alone
h5="$job/h5"; mkdir -p "$h5"
runj "$h5" "JERRITO_VRAM_FREE_MB=4000 JERRITO_VRAM_GRACE=0" >/dev/null
pid=$(state "$h5" pid)
sleep 8
alive "$pid" && ok "no pressure: the server survives the watchdog" || no "no pressure: the server survives the watchdog" "pid $pid died"
stopj "$h5"

# pressure, but the default 60 s grace has not passed: a tool round in flight
# must not lose its server
h6="$job/h6"; mkdir -p "$h6"
runj "$h6" "JERRITO_VRAM_FREE_MB=100" >/dev/null
pid=$(state "$h6" pid)
sleep 8
alive "$pid" && ok "grace window: recent activity is respected" || no "grace window: recent activity is respected" "pid $pid died"
stopj "$h6"

# pressure, quiet, but the server says it is generating: leave it
h7="$job/h7"; mkdir -p "$h7"
runj "$h7" "JERRITO_VRAM_FREE_MB=100 JERRITO_VRAM_GRACE=0 FAKE_BUSY=1" >/dev/null
pid=$(state "$h7" pid)
sleep 8
alive "$pid" && ok "a busy server is never killed" || no "a busy server is never killed" "pid $pid died"
stopj "$h7"

echo
echo "== vram reading: the real command, not just the override =="
# `nvidia-smi` newline-terminates its output, and Number('') is 0: that once made
# every reading look like "0 MB free", so an idle server was killed every time
cat > /tmp/vram-parse.mjs <<'VEOF'
const m = await import(process.env.JERRITO_FILE);
const cases = [['4825\n', 4825], ['1000\n2000\n', 1000], ['  512 \n', 512], ['4096', 4096], ['', null], ['n/a\n', null]];
for (const [input, want] of cases) {
  const got = m.parseSmFreeMiB(input);
  console.log(`${got === want ? 'PASS' : 'FAIL'}  parseSmFreeMiB(${JSON.stringify(input)}) -> ${got}${got === want ? '' : ` (wanted ${want})`}`);
}
VEOF
count < <(JERRITO_FILE="$H" node /tmp/vram-parse.mjs 2>&1)

mkdir -p "$job/fakebin"
stub_vram() { printf '#!/bin/sh\necho "%s"\n' "$1" > "$job/fakebin/nvidia-smi"; chmod +x "$job/fakebin/nvidia-smi"; }
stub_vram 4096
out=$(JERRITO_FILE="$H" PATH="$job/fakebin:$PATH" node -e 'const m = await import(process.env.JERRITO_FILE); const v = m.vramFreeBytes(); console.log(v === null ? "null" : Math.round(v / 2 ** 20))' 2>&1)
has "a stubbed nvidia-smi reading is believed (4096 MB, trailing newline)" "4096" "$out"
stub_vram 100
out=$(JERRITO_FILE="$H" PATH="$job/fakebin:$PATH" node -e 'const m = await import(process.env.JERRITO_FILE); console.log(Math.round(m.vramFreeBytes() / 2 ** 20))' 2>&1)
has "a low stubbed reading is believed too (100 MB)" "100" "$out"

# with plenty of VRAM on the (stubbed) command line, an idle server must survive
# even with the grace turned off — this is exactly what the 0 MB bug broke
stub_vram 4096
h8="$job/h8"; mkdir -p "$h8"
HOME="$h8" PATH="$job/fakebin:$PATH" JERRITO_BIN_DIR="$job/bin" JERRITO_MODEL_FILE="$job/fake-qwen3.gguf" \
  JERRITO_4GET_URL=off JERRITO_VRAM_GRACE=0 timeout 40 node "$H" "say ok" >/dev/null 2>&1
pid=$(state "$h8" pid)
[ -n "$pid" ] && ok "stub VRAM: a server was started (pid $pid)" || no "stub VRAM: server started" "no pid"
sleep 8
alive "$pid" && ok "plenty of VRAM (4096 MB): an idle server is left alone" || no "plenty of VRAM: server survives" "pid $pid was killed"
stopj "$h8"

# and when the same path reports almost nothing, it is stopped
stub_vram 100
h9="$job/h9"; mkdir -p "$h9"
HOME="$h9" PATH="$job/fakebin:$PATH" JERRITO_BIN_DIR="$job/bin" JERRITO_MODEL_FILE="$job/fake-qwen3.gguf" \
  JERRITO_4GET_URL=off JERRITO_VRAM_GRACE=0 timeout 40 node "$H" "say ok" >/dev/null 2>&1
pid=$(state "$h9" pid)
killed=no
for i in $(seq 1 14); do sleep 1; alive "$pid" || { killed=yes; break; }; done
[ "$killed" = yes ] && ok "a low reading (100 MB) still kills the idle server" || no "low reading kills" "pid $pid survived"
stopj "$h9"

echo
echo "== summary: $pass passed, $fail failed =="
[ "$fail" = 0 ]