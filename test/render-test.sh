#!/usr/bin/env bash
# rendering: markdown styling, and the thinking/tool panel collapsing on a TTY
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
H="$HERE/../helper.mjs"
cd "$HERE/.." || exit 1
pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass+1)); }
no() { echo "FAIL  $1${2:+  <<< $2}"; fail=$((fail+1)); }
has() { local n="$1" s="$2" o="$3"; case "$o" in *"$s"*) ok "$n";; *) no "$n" "expected '$s' in: $(printf '%s' "$o" | tail -c 200)";; esac; }
hasnt() { local n="$1" s="$2" o="$3"; case "$o" in *"$s"*) no "$n" "unexpected '$s'";; *) ok "$n";; esac; }

echo "== markdown styling (unit) =="
cat > /tmp/md-test.mjs <<'EOF'
const { styleMdLine } = await import(process.env.HELPER_FILE);
let fail = 0;
const ok = (n, c, extra = '') => { if (c) console.log('PASS  ' + n); else { console.log('FAIL  ' + n + (extra ? '  <<< ' + extra : '')); fail++; } };
const fresh = () => ({ inFence: false });
const s = (line, state = fresh()) => styleMdLine(line, state);

const bold = s('a **b** c');
ok('**bold** -> ANSI bold, markers gone', bold.includes('\x1b[1mb\x1b[22m') && !bold.includes('**'), JSON.stringify(bold));
const code = s('use `nix build` now');
ok('`code` -> cyan, backticks gone', code.includes('\x1b[36mnix build\x1b[39m') && !code.includes('`'), JSON.stringify(code));
const head = s('## Title');
ok('heading styled', head.includes('Title') && head.includes('\x1b['), JSON.stringify(head));
const st1 = fresh();
const fence = s('```nix', st1);
ok('fence line dimmed + toggles state', fence.includes('\x1b[2m') && st1.inFence === true, JSON.stringify(fence));
ok('markdown inside fence untouched', s('a **b** `c`', st1) === 'a **b** `c`');
ok('link text underlined', s('see [docs](https://nix.dev)').includes('\x1b[4mdocs\x1b[24m'));
ok('** inside code stays literal', s('`**not bold**`').includes('**not bold**'));
const nested = s('**Sci-fi hit *The Eternaut* on Netflix** (viral starfish)');
ok('bold containing italic', nested.includes('\x1b[1m') && nested.includes('\x1b[3mThe Eternaut\x1b[23m') && !nested.includes('*'), JSON.stringify(nested));
ok('*italic* alone', s('*solo*').includes('\x1b[3msolo\x1b[23m'));
ok('***both***', s('***x***').includes('\x1b[1m\x1b[3mx\x1b[23m'));
ok('spaced asterisks untouched', s('2 * 3 * 4') === '2 * 3 * 4');
ok('code inside bold survives', s('**a `c` b**').includes('\x1b[36mc\x1b[39m'));
if (process.env.WITHOUT_COLOR) ok('no escape codes without colour', s('**x**') === '**x**');
process.exit(fail ? 1 : 0);
EOF
out=$(FORCE_COLOR=1 HELPER_FILE="$H" node /tmp/md-test.mjs 2>&1); echo "$out"
pass=$((pass + $(printf '%s\n' "$out" | grep -c '^PASS')))
fail=$((fail + $(printf '%s\n' "$out" | grep -c '^FAIL')))
if WITHOUT_COLOR=1 HELPER_FILE="$H" node -e 'const { styleMdLine } = await import(process.env.HELPER_FILE); process.exit(styleMdLine("**x**", { inFence: false }) === "**x**" ? 0 : 1)'; then
  ok "no escape codes without colour"
else
  no "no escape codes without colour"
fi

echo
echo "== panel collapse (pty vs pipe, against a scripted server) =="
MP=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{const p=s.address().port;console.log(p);s.close()})')
export MOCK_PORT=$MP
cat > /tmp/mock-render.mjs <<'MOCK'
import http from 'node:http';
const send = (res, o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
const delta = (res, d) => send(res, { id: 'x', choices: [{ index: 0, delta: d }] });
http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', data: [{ id: 'mock' }] }));
  }
  const j = JSON.parse(body || '{}');
  const user = (j.messages || []).find((m) => m.role === 'user')?.content || '';
  const sawTool = (j.messages || []).some((m) => m.role === 'tool');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (!sawTool) {
    delta(res, { role: 'assistant', content: '' });
    const abs = /absolute/i.test(user);
    const many = /many reads/i.test(user);
    const root = process.cwd();
    const args = many
      ? ['a1.sh', 'a2.sh', 'a3.sh', 'a4.sh', 'a5.sh', 'a6.sh', 'a7.sh'].map((p) => ({ path: p, limit: 5 }))
      : abs
        ? [{ path: root + '/helper.mjs', limit: 5 }, { path: root + '/helper.mjs', offset: 20, limit: 5 }]
        : [{ path: 'helper.mjs', limit: 5 }, { path: 'helper.mjs', offset: 20, limit: 5 }];
    args.forEach((a, i) => delta(res, { tool_calls: [{ index: i, id: 'c' + i, type: 'function', function: { name: 'read', arguments: JSON.stringify(a) } }] }));
  } else if (user.includes('empty')) {
    // tool call, then nothing: exercises the empty-response path while a panel is on screen
  } else {
    for (const line of ['Here is **bold** and `code`.', '- a [link](https://nix.dev) item']) delta(res, { content: line + '\n' });
  }
  // llama.cpp sends cumulative timings in every chunk when asked; the footer
  // uses the last one. include it so the primary (server-timings) path is tested
  send(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], timings: { prompt_n: 500, prompt_ms: 200, predicted_n: 42, predicted_ms: 3000 } });
  res.write('data: [DONE]\n\n');
  res.end();
}).listen(Number(process.env.MOCK_PORT), '127.0.0.1');
MOCK

node /tmp/mock-render.mjs & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
for i in $(seq 1 50); do curl -sf http://127.0.0.1:$MP/v1/models >/dev/null 2>&1 && break; sleep 0.2; done

Q="read the project"
pty_out=$(script -qec "env HELPER_BASE_URL=http://127.0.0.1:$MP/v1 node $H '$Q'" /dev/null 2>&1 | tr -d '\r')
pipe_out=$(env HELPER_BASE_URL=http://127.0.0.1:$MP/v1 node "$H" "$Q" 2>&1)
pipe_forced=$(env HELPER_BASE_URL=http://127.0.0.1:$MP/v1 FORCE_COLOR=1 node "$H" "$Q" 2>&1)

has   "pty: summary line shown" "▸" "$pty_out"
has   "pty: answer styled bold" "$(printf '\033[1mbold')" "$pty_out"
has   "pty: cursor erase sequence used" "$(printf '\033[')" "$pty_out"
hasnt "pty: no raw ** markers left" "**" "$pty_out"
has   "pty: summary names the tool arguments" "read helper.mjs:1-5" "$pty_out"
has   "pty: a second range of the same file is not a duplicate" "read helper.mjs:20-24" "$pty_out"
hasnt "pty: ranges of one file are not collapsed into x2" "×2" "$pty_out"
after_summary=$(awk '/▸/ { f = 1; next } f' <<< "$pty_out")
hasnt "pty: panel not redrawn after the summary" "⚙" "$after_summary"

abs_out=$(script -qec "env HELPER_BASE_URL=http://127.0.0.1:$MP/v1 node $H 'absolute path'" /dev/null 2>&1 | tr -d '\r')
has   "pty: absolute paths render relative to the project root" "read helper.mjs:1-5" "$abs_out"
hasnt "pty: the project root is not repeated in the panel" "$PWD" "$abs_out"

many_out=$(script -qec "env HELPER_BASE_URL=http://127.0.0.1:$MP/v1 node $H 'many reads'" /dev/null 2>&1 | tr -d '\r')
line=$(awk '/▸/ { print; exit }' <<< "$many_out")
grep -qE '\+[0-9]+ more' <<< "$line" && ok "pty: a long tool list collapses to a count" || no "pty: long tool list collapses" "$line"
grep -qE '\.s \.\.\.' <<< "$line" && no "pty: names are not cut mid-token" "$line" || ok "pty: names are not cut mid-token"
[ "${#line}" -le 90 ] && ok "pty: summary line fits the terminal (${#line} cols)" || no "pty: summary fits" "${#line} cols"
has   "pipe: tool line kept (no pty, no collapse)" "⚙" "$pipe_out"
has   "pipe: markdown left as-is" "**bold**" "$pipe_out"
hasnt "pipe: no escape codes" "$(printf '\033[')" "$pipe_out"
has   "pipe + FORCE_COLOR: styled answer" "$(printf '\033[1mbold')" "$pipe_forced"
hasnt "pipe + FORCE_COLOR: no cursor erasing" "$(printf '\033[J')" "$pipe_forced"

has   "pty: footer shows tok/s" "tok/s" "$pty_out"
hasnt "pipe: no footer in piped output" "tok/s" "$pipe_out"

empty_out=$(script -qec "env HELPER_BASE_URL=http://127.0.0.1:$MP/v1 node $H 'empty answer'" /dev/null 2>&1 | tr -d '\r')
case "$empty_out" in
  *"(empty response"*|*"(no answer after"*) ok "pty: empty answer still prints the notice";;
  *) no "pty: empty answer still prints the notice" "$(printf %s "$empty_out" | tail -c 160)";;
esac
has   "pty: empty answer still collapses the panel" "▸" "$empty_out"

echo
echo "== summary: $pass passed, $fail failed =="
[ "$fail" = 0 ]
