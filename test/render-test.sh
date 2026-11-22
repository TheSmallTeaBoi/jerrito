#!/usr/bin/env bash
# rendering: markdown styling, and the thinking/tool panel collapsing on a TTY
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
H="$HERE/../jerrito.mjs"
cd "$HERE/.." || exit 1
pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass+1)); }
no() { echo "FAIL  $1${2:+  <<< $2}"; fail=$((fail+1)); }
has() { local n="$1" s="$2" o="$3"; case "$o" in *"$s"*) ok "$n";; *) no "$n" "expected '$s' in: $(printf '%s' "$o" | tail -c 200)";; esac; }
hasnt() { local n="$1" s="$2" o="$3"; case "$o" in *"$s"*) no "$n" "unexpected '$s'";; *) ok "$n";; esac; }

echo "== markdown styling (unit) =="
cat > /tmp/md-test.mjs <<'EOF'
const { styleMdLine, flushTable, wrapCell, fitWidths, capPanelRows } = await import(process.env.JERRITO_FILE);
let fail = 0;
const ok = (n, c, extra = '') => { if (c) console.log('PASS  ' + n); else { console.log('FAIL  ' + n + (extra ? '  <<< ' + extra : '')); fail++; } };
const fresh = () => ({ inFence: false });
const s = (line, state = fresh()) => styleMdLine(line, state);
const plain = (t) => t.replace(/\x1b\[[0-9;]*m/g, '');
// table rows come back buffered (null) and are flushed as one block
const table = (rows) => { const st = fresh(); const held = rows.map((r) => s(r, st)); return { held, out: flushTable(st) }; };
const bold = s('a **b** c');
ok('**bold** -> ANSI bold, markers gone', bold.includes('\x1b[1mb\x1b[22m') && !bold.includes('**'), JSON.stringify(bold));
const code = s('use `nix build` now');
ok('`code` -> cyan, backticks gone', code.includes('\x1b[36mnix build\x1b[39m') && !code.includes('`'), JSON.stringify(code));
const head = s('## Title');
ok('heading styled', head.includes('Title') && head.includes('\x1b['), JSON.stringify(head));
ok('heading markers are dropped, not echoed', plain(head) === 'Title' && head.includes('\x1b[1mTitle'), JSON.stringify(head));
ok('deeper headings and trailing hashes', plain(s('### Deeper ##')) === 'Deeper');
ok('indented heading still matches', plain(s('  ## Nested')) === '  Nested' && s('  ## Nested').includes('\x1b[1m'));
ok('bold inside a heading survives', plain(s('## **A** b')) === 'A b' && s('## **A** b').includes('\x1b[1mA'));
const st1 = fresh();
const fence = s('```nix', st1);
ok('fence line dimmed + toggles state', fence.includes('\x1b[2m') && st1.inFence === true, JSON.stringify(fence));
ok('fence opens with a rail + language, no backticks', /\x1b\[2m┌─/.test(fence) && fence.includes('nix') && !fence.includes('`'), JSON.stringify(fence));
const inside = s('a **b** `c`', st1);
ok('markdown inside fence untouched', inside.replace(/\x1b\[[0-9;]*m/g, '').replace(/^│ /, '') === 'a **b** `c`' && !/\x1b\[[134]m/.test(inside), JSON.stringify(inside));
const rail = s('    if (x) y();', st1);
ok('code keeps its indent after the rail', plain(rail) === '│     if (x) y();', JSON.stringify(rail));
ok('blank line inside a block keeps the rail', s('', st1).includes('│'));
// a block nested under a list item: the rail follows the fence, the code keeps
// its indentation relative to it (it used to walk rightwards line by line)
const nest = fresh();
const nestOpen = s('   ```sh', nest);
ok('an indented fence opens at its own indent', plain(nestOpen) === '   ┌─ sh', JSON.stringify(nestOpen));
ok('code inside it hangs off one straight rail', plain(s('   nix develop', nest)) === '   │ nix develop', JSON.stringify(s('   nix develop', nest)));
ok('deeper code keeps its extra indent, rail does not move', plain(s('     nested', nest)) === '   │   nested', JSON.stringify(s('     nested', nest)));
ok('the closing rail lines up with the opening one', plain(s('   ```', nest)) === '   └─', JSON.stringify(s('   ```', nest)));
const tilde = fresh();
ok('~~~ fences work as fences', plain(s('~~~js', tilde)) === '┌─ js' && tilde.inFence === true);
ok('a different marker inside a ~~~ block is code', plain(s('```not a fence', tilde)) === '│ ```not a fence' && tilde.inFence === true);
ok('the matching marker closes it', plain(s('~~~', tilde)) === '└─' && tilde.inFence === false);
ok('a fence with an info string inside a block is content', (() => { const st = fresh(); s('```sh', st); return st.inFence && plain(s('```sh', st)) === '│ ```sh' && st.inFence; })());

// ---- tables: buffered, aligned, header bold, delimiter row becomes a rule
const t1 = table(['| Name | Value |', '| :--- | ---: |', '| alpha | 1 |', '| longer | 22 |']);
ok('table rows are buffered until the table ends', t1.held.every((h) => h === null), JSON.stringify(t1.held));
ok('the line after a table flushes it first', (() => { const st = fresh(); s('| a | b |', st); const next = s('done', st); return next.endsWith('done') && next.includes('│'); })());
ok('no raw pipes or dashes survive', !/[|]/.test(plain(t1.out)) && !/-{2,}/.test(plain(t1.out)), JSON.stringify(plain(t1.out)));
ok('columns are aligned to the widest cell', (() => { const l = plain(t1.out).split('\n').filter((x) => !x.includes('┼')); const at = l.map((x) => x.indexOf('│')); return at[0] > 0 && at.every((c) => c === at[0]) && l[1].startsWith('alpha '); })(), JSON.stringify(plain(t1.out)));
ok('the header is bold', t1.out.includes('\x1b[1mName'));
ok('the delimiter row becomes a rule', plain(t1.out).split('\n')[1].includes('─┼─'));
ok('right alignment is honoured', plain(t1.out).split('\n')[2].trim().endsWith('1') && plain(t1.out).split('\n')[2].includes('    1'), JSON.stringify(plain(t1.out)));
ok('inline markdown inside cells is styled', table(['| a |', '|---|', '| **b** |']).out.includes('\x1b[1mb'));
ok('links in cells drop the URL', plain(table(['| a |', '|---|', '| [t](https://x.example) |']).out).split('\n')[2].trim() === 't');
ok('a table without a delimiter row is still aligned', plain(table(['| a | b |', '| ccc | d |']).out) === 'a   │ b\n────┼──\nccc │ d');
ok('that first row is treated as the header too', table(['| a | b |', '| ccc | d |']).out.startsWith('\x1b[1ma'));
ok('a one-row pipe block gets no rule', plain(table(['| just | one |']).out) === 'just │ one');
// double-width characters are padded as two cells, or the grid drifts
const dw = (l) => [...l].reduce((n, c) => n + (/[\u3000-\u9fff\uff00-\uff60]/u.test(c) ? 2 : 1), 0);
const cjk = plain(table(['| 名前 | 値 |', '|---|---|', '| 日本語 | 1 |', '| a | 22 |']).out).split('\n');
ok('wide characters get two columns of padding', new Set(cjk.map(dw)).size === 1, JSON.stringify(cjk));
ok('wide characters wrap on display width', (() => {
  const l = plain(table(['| a |', '| ' + '日本語'.repeat(10) + ' |']).out).split('\n');
  return l.every((x) => dw(x) <= 80);
})());
ok('pipes without surrounding bars are not a table', s('ls | grep | wc') === 'ls | grep | wc');
ok('an indented table keeps its indent (rule included)', plain(table(['  | a | bb |', '  |---|---|', '  | 1 | 2 |']).out) === '  a │ bb\n  ──┼───\n  1 │ 2 ');
ok('an empty table flush is a no-op', flushTable(fresh()) === '');
const close = s('```', st1);
ok('fence closes with a rail and clears state', /\x1b\[2m└─/.test(close) && st1.inFence === false && !close.includes('`'), JSON.stringify(close));
ok('prose after the block is styled again', s('**b**', st1).includes('\x1b[1mb'));
ok('link text underlined', s('see [docs](https://nix.dev)').includes('\x1b[4mdocs\x1b[24m'));
ok('** inside code stays literal', s('`**not bold**`').includes('**not bold**'));
const nested = s('**Sci-fi hit *The Eternaut* on Netflix** (viral starfish)');
ok('bold containing italic', nested.includes('\x1b[1m') && nested.includes('\x1b[3mThe Eternaut\x1b[23m') && !nested.includes('*'), JSON.stringify(nested));
ok('*italic* alone', s('*solo*').includes('\x1b[3msolo\x1b[23m'));
ok('***both***', s('***x***').includes('\x1b[1m\x1b[3mx\x1b[23m'));
ok('spaced asterisks untouched', s('2 * 3 * 4') === '2 * 3 * 4');
ok('code inside bold survives', s('**a `c` b**').includes('\x1b[36mc\x1b[39m'));

// ---- a table wider than the terminal keeps its grid by wrapping cells
const long = 'GPT-6.2 Astra input $8 per 1M tokens, output $40 per 1M tokens, Sol $2/$10, Terra $1/$5';
const wide = plain(table([
  '| Dimension | OpenAI | Google AI | Microsoft |',
  '| :--- | :--- | :--- | ---: |',
  `| Flagship model | ${long} | Gemini 4, Gemini Omni 1.2 Flash | Azure OpenAI, Copilot |`,
  `| API pricing | ${long} | Usage-based via the Google Cloud Gemini API | prices via the Azure portal |`,
]).out);
const wl = wide.split('\n');
ok('a wide table still fits the terminal', wl.every((l) => l.length <= 80), 'widest ' + Math.max(...wl.map((l) => l.length)));
ok('the rails stay in one column across wraps', (() => {
  const at = wl.filter((l) => !l.includes('┼')).map((l) => [...l].map((c, i) => (c === '│' ? i : -1)).filter((i) => i >= 0).join(','));
  return at.length > 2 && new Set(at).size === 1;
})(), JSON.stringify(wl.slice(0, 3)));
ok('a wide row is taller than one line', wl.length > 8, wl.length);
ok('no cell text is lost to wrapping', ['Flagship', 'Astra', 'Omni', 'portal'].every((w) => wide.includes(w)));
ok('the header rule survives a wrapped table', wl.some((l) => l.includes('┼')));
ok('a long word is cut, not overflowed', plain(table(['| a |', '| ' + 'x'.repeat(200) + ' |']).out).split('\n').every((l) => l.length <= 80));
ok('wrapCell keeps a markup span whole', (() => {
  const chunks = wrapCell('alpha **bold phrase here** omega', 12);
  return chunks.every((c) => (c.match(/\*\*/g) || []).length % 2 === 0);
})(), JSON.stringify(wrapCell('alpha **bold phrase here** omega', 12)));
ok('fitWidths leaves a narrow column alone', (() => {
  const w = fitWidths([3, 60, 40], 60);
  return w[0] === 3 && w.reduce((a, b) => a + b, 0) <= 60;
})(), JSON.stringify(fitWidths([3, 60, 40], 60)));
ok('fitWidths does nothing when it all fits', JSON.stringify(fitWidths([4, 5], 40)) === '[4,5]');

// ---- the tool panel must not outgrow the screen (it drew itself twice)
const rows40 = Array.from({ length: 40 }, (_, i) => 'row ' + i);
const capped = capPanelRows(rows40, 24);
ok('a panel taller than the terminal is capped', capped.length === 23, String(capped.length));
ok('capping keeps the newest rows', capped[capped.length - 1] === 'row 39' && capped[0] === 'row 17', capped[0] + '..' + capped[capped.length - 1]);
ok('a short panel is untouched', capPanelRows(['a', 'b'], 24).length === 2);
ok('capping never goes below a few rows', capPanelRows(rows40, 2).length === 3);
if (process.env.WITHOUT_COLOR) ok('no escape codes without colour', s('**x**') === '**x**');
process.exit(fail ? 1 : 0);
EOF
out=$(FORCE_COLOR=1 JERRITO_FILE="$H" node /tmp/md-test.mjs 2>&1); echo "$out"
pass=$((pass + $(printf '%s\n' "$out" | grep -c '^PASS')))
fail=$((fail + $(printf '%s\n' "$out" | grep -c '^FAIL')))
if WITHOUT_COLOR=1 JERRITO_FILE="$H" node -e 'const { styleMdLine } = await import(process.env.JERRITO_FILE); const st = { inFence: false }; process.exit(styleMdLine("**x**", { inFence: false }) === "**x**" && styleMdLine("```nix", st) === "```nix" && styleMdLine("┌─", st) === "┌─" ? 0 : 1)'; then
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
        ? [{ path: root + '/jerrito.mjs', limit: 5 }, { path: root + '/jerrito.mjs', offset: 20, limit: 5 }]
        : [{ path: 'jerrito.mjs', limit: 5 }, { path: 'jerrito.mjs', offset: 20, limit: 5 }];
    args.forEach((a, i) => delta(res, { tool_calls: [{ index: i, id: 'c' + i, type: 'function', function: { name: 'read', arguments: JSON.stringify(a) } }] }));
  } else if (user.includes('empty')) {
    // tool call, then nothing: exercises the empty-response path while a panel is on screen
  } else if (user.includes('code block')) {
    for (const line of ['Try this:', '```sh', 'nix develop -c j "q"', '```']) delta(res, { content: line + '\n' });
  } else if (user.includes('wide table')) {
    const cell = 'GPT-6.2 Astra input $8 per 1M tokens, output $40 per 1M tokens, Sol $2/$10, Terra $1/$5';
    for (const line of ['## Pricing', '', '| Provider | Model | Price |', '| :--- | :--- | ---: |', `| OpenAI | ${cell} | 8/40 |`, `| Google | ${cell} | 1/5 |`]) delta(res, { content: line + '\n' });
  } else if (user.includes('table')) {
    for (const line of ['## Plan', '', '| Step | Owner |', '| :--- | ---: |', '| build | 1 |', '| ship | 22 |']) delta(res, { content: line + '\n' });
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
pty_out=$(script -qec "env JERRITO_BASE_URL=http://127.0.0.1:$MP/v1 node $H '$Q'" /dev/null 2>&1 | tr -d '\r')
pipe_out=$(env JERRITO_BASE_URL=http://127.0.0.1:$MP/v1 node "$H" "$Q" 2>&1)
pipe_forced=$(env JERRITO_BASE_URL=http://127.0.0.1:$MP/v1 FORCE_COLOR=1 node "$H" "$Q" 2>&1)

has   "pty: summary line shown" "▸" "$pty_out"
has   "pty: answer styled bold" "$(printf '\033[1mbold')" "$pty_out"
has   "pty: cursor erase sequence used" "$(printf '\033[')" "$pty_out"
hasnt "pty: no raw ** markers left" "**" "$pty_out"
has   "pty: summary names the tool arguments" "read jerrito.mjs:1-5" "$pty_out"
has   "pty: a second range of the same file is not a duplicate" "read jerrito.mjs:20-24" "$pty_out"
hasnt "pty: ranges of one file are not collapsed into x2" "×2" "$pty_out"
after_summary=$(awk '/▸/ { f = 1; next } f' <<< "$pty_out")
hasnt "pty: panel not redrawn after the summary" "⚙" "$after_summary"

abs_out=$(script -qec "env JERRITO_BASE_URL=http://127.0.0.1:$MP/v1 node $H 'absolute path'" /dev/null 2>&1 | tr -d '\r')
has   "pty: absolute paths render relative to the project root" "read jerrito.mjs:1-5" "$abs_out"
hasnt "pty: the project root is not repeated in the panel" "$PWD" "$abs_out"

many_out=$(script -qec "env JERRITO_BASE_URL=http://127.0.0.1:$MP/v1 node $H 'many reads'" /dev/null 2>&1 | tr -d '\r')
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

# a fenced block must render as a rail on a TTY and stay literal markdown in a pipe
code_out=$(script -qec "env JERRITO_BASE_URL=http://127.0.0.1:$MP/v1 node $H 'a code block'" /dev/null 2>&1 | tr -d '\r')
code_pipe=$(env JERRITO_BASE_URL=http://127.0.0.1:$MP/v1 node "$H" 'a code block' 2>&1)
has   "pty: the closing fence becomes a rail" "└─" "$code_out"
hasnt "pty: no literal fence markers in the answer" '```' "$code_out"
grep -q '│ .*nix develop -c j' <<< "$code_out" && ok "pty: code block renders on a rail" || no "pty: code block renders on a rail" "$(printf %s "$code_out" | tail -c 200)"
has   "pipe: code block stays raw markdown" '```sh' "$code_pipe"

# a title and a table: markers and pipes must be rendered on a TTY, untouched in a pipe
tbl_out=$(script -qec "env JERRITO_BASE_URL=http://127.0.0.1:$MP/v1 node $H 'a table'" /dev/null 2>&1 | tr -d '\r')
tbl_pipe=$(env JERRITO_BASE_URL=http://127.0.0.1:$MP/v1 node "$H" 'a table' 2>&1)
hasnt "pty: no ## markers left on a title" '## Plan' "$tbl_out"
has   "pty: the title text survives" 'Plan' "$tbl_out"
hasnt "pty: no raw table pipes" '| build |' "$tbl_out"
hasnt "pty: the delimiter row is not printed" '| :--- |' "$tbl_out"
grep -q 'build.*│' <<< "$tbl_out" && ok "pty: table rows render in cells" || no "pty: table rows render in cells" "$(printf %s "$tbl_out" | tail -c 200)"
grep -q '┼' <<< "$tbl_out" && ok "pty: the delimiter row becomes a rule" || no "pty: table rule" "$(printf %s "$tbl_out" | tail -c 200)"
has   "pipe: title stays raw markdown" '## Plan' "$tbl_pipe"
has   "pipe: table stays raw markdown" '| :--- | ---: |' "$tbl_pipe"

# a table that does not fit the terminal wraps its cells instead of overflowing
wide_out=$(script -qec "env JERRITO_BASE_URL=http://127.0.0.1:$MP/v1 node $H 'a wide table'" /dev/null 2>&1 | tr -d '\r')
wide_rows=$(awk '/▸/ { f = 1; next } f' <<< "$wide_out" | sed 's/\x1b\[[0-9;]*m//g')
grep -q '┼' <<< "$wide_rows" && ok "pty: a wide table keeps its rule" || no "pty: wide table rule" "$(printf %s "$wide_rows" | tail -c 160)"
grep -q 'OpenAI' <<< "$wide_rows" && grep -q '│' <<< "$wide_rows" && ok "pty: a wide table keeps its columns" || no "pty: wide table columns" "$(printf %s "$wide_rows" | tail -c 160)"
wide_max=$(printf '%s\n' "$wide_rows" | node -e 'let m = 0; for (const l of require("fs").readFileSync(0, "utf8").split("\n")) m = Math.max(m, [...l].length); console.log(m)')
[ "$wide_max" -le 79 ] && ok "pty: a wide table fits the 80-col terminal (${wide_max})" || no "pty: wide table fits" "${wide_max} cols"

empty_out=$(script -qec "env JERRITO_BASE_URL=http://127.0.0.1:$MP/v1 node $H 'empty answer'" /dev/null 2>&1 | tr -d '\r')
case "$empty_out" in
  *"(empty response"*|*"(no answer after"*) ok "pty: empty answer still prints the notice";;
  *) no "pty: empty answer still prints the notice" "$(printf %s "$empty_out" | tail -c 160)";;
esac
has   "pty: empty answer still collapses the panel" "▸" "$empty_out"

echo
echo
echo "== footer: parallel tool calls count once =="
cat > /tmp/footer-test.mjs <<'EOF'
const { makeTurnRenderer } = await import(process.env.JERRITO_FILE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r = makeTurnRenderer();
r.usage({ tok: 120, ms: 1000 });
// two searches at the same time: 400 ms of wall time, 800 ms if summed
const a = r.tool('web_search', { query: 'alpha' });
const b = r.tool('web_search', { query: 'beta' });
await sleep(400);
r.toolResult('1) alpha', a);
r.toolResult('1) beta', b);
// then one on its own
const c = r.tool('web_fetch', { url: 'https://x.example' });
await sleep(100);
r.toolResult('# fetched', c);
r.finish();
r.footer();
EOF
out=$(script -qec "env JERRITO_FILE=$H node /tmp/footer-test.mjs" /dev/null 2>&1 | tr -d '\r')
grep -qE 'search 0\.[45]s' <<< "$out" && ok "footer: overlapping searches count once (wall time)" || no "footer: overlapping searches" "$(grep -o 'search [0-9.]*s' <<< "$out")"
grep -qE 'search 0\.(8|9)s' <<< "$out" && no "footer: overlapping calls are not summed" "$(grep -o 'search [0-9.]*s' <<< "$out")" || ok "footer: overlapping calls are not summed"
grep -qE 'fetch 0\.1s' <<< "$out" && ok "footer: a separate tool keeps its own time" || no "footer: separate tool time" "$(grep -o 'fetch [0-9.]*s' <<< "$out")"

echo "== summary: $pass passed, $fail failed =="
[ "$fail" = 0 ]
