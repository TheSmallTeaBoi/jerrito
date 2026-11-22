#!/usr/bin/env bash
# agent-loop tests against a scripted mock OpenAI server (no real model)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
H="$HERE/../jerrito.mjs"
cd "$HERE/.." || exit 1
pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass+1)); }
no() { echo "FAIL  $1${2:+  <<< $2}"; fail=$((fail+1)); }
has() { local n="$1" s="$2" o="$3"; case "$o" in *"$s"*) ok "$n";; *) no "$n" "expected '$s' in: $(printf '%s' "$o" | tail -c 220)";; esac; }
hasnt() { local n="$1" s="$2" o="$3"; case "$o" in *"$s"*) no "$n" "unexpected '$s'";; *) ok "$n";; esac; }

MP=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{const p=s.address().port;console.log(p);s.close()})')
export MOCK_PORT=$MP
cat > /tmp/mock-agent.mjs <<'MOCK'
import http from 'node:http';
import fs from 'node:fs';
const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const delta = (res, d) => send(res, { id: 'x', choices: [{ index: 0, delta: d }] });

http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;

  // models + health probes: everything that is not a chat completion
  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', data: [{ id: 'mock' }] }));
  }

  const j = JSON.parse(body || '{}');
  const user = (j.messages?.find((m) => m.role === 'user')?.content || '').toLowerCase();
  const toolResults = (j.messages || []).filter((m) => m.role === 'tool');
  const hasTools = Array.isArray(j.tools) && j.tools.length > 0;
  fs.appendFileSync('/tmp/mock-agent.log', `tools=${hasTools ? 'yes' : 'no'}\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

  if (user.includes('loop forever')) {
    // a model that keeps calling tools; only answers once the tools are taken away
    if (hasTools) delta(res, { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'read', arguments: '{"path":"."}' } }] });
    else for (const w of ['forced', 'answer']) delta(res, { content: w + ' ' });
    send(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  } else if (!toolResults.length) {
    delta(res, { role: 'assistant', content: '' });
    if (user.includes('two tools')) {
      delta(res, { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'read', arguments: '{"path":' } }] });
      delta(res, { tool_calls: [{ index: 0, function: { arguments: '"."}' } }] });
      delta(res, { tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'web_search', arguments: '{"query":"dummy"}' } }] });
    } else if (user.includes('object args')) {
      delta(res, { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'read', arguments: { path: '.' } } }] });
    } else if (user.includes('bad json')) {
      delta(res, { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'read', arguments: '{"path":' } }] });
    } else if (user.includes('unknown tool')) {
      delta(res, { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'shell', arguments: '{"cmd":"rm -rf /"}' } }] });
    } else if (user.includes('two text calls')) {
      // two calls written as text in one message: both must run, in one batch
      delta(res, { content: '<function=read{"path":"."}</function>\n<function=read{"path":"jerrito.mjs","limit":3}</function>' });
    } else if (user.includes('xml call')) {
      // a model that writes the call as text instead of using tool_calls
      delta(res, { content: '<function name="read"><param name="path">.</param><param name="limit">3</param></function>' });
    } else if (user.includes('tag call')) {
      delta(res, { content: '<function=read{"path":"."}</function>' });
    } else if (user.includes('json call')) {
      delta(res, { content: '{"name":"read","arguments":{"path":"."}}' });
    } else if (user.includes('prose json')) {
      delta(res, { content: '{"a":1} is just a JSON object, not a call' });
    } else if (user.includes('big read')) {
      delta(res, { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'read', arguments: '{"path":"jerrito.mjs","limit":250}' } }] });
    } else if (user.includes('two searches')) {
      // two searches in one turn: they must run at the same time
      delta(res, { tool_calls: [{ index: 0, id: 's0', type: 'function', function: { name: 'web_search', arguments: '{"query":"alpha"}' } }] });
      delta(res, { tool_calls: [{ index: 1, id: 's1', type: 'function', function: { name: 'web_search', arguments: '{"query":"beta"}' } }] });
    } else if (!user.includes('empty')) {
      delta(res, { content: 'plain answer' });
    }
    send(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } });
  } else {
    const preview = (toolResults[0]?.content || '').slice(0, 120).replace(/\n/g, ' ');
    for (const w of `tools=${toolResults.length} first=${preview}`.split(' ')) delta(res, { content: w + ' ' });
    send(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4 } });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}).listen(Number(process.env.MOCK_PORT), '127.0.0.1');
MOCK

node /tmp/mock-agent.mjs & MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
for i in $(seq 1 50); do curl -sf http://127.0.0.1:$MP/v1/models >/dev/null 2>&1 && break; sleep 0.2; done
curl -sf http://127.0.0.1:$MP/v1/models >/dev/null || { echo "mock server did not start"; exit 1; }

run() { timeout 30 env JERRITO_BASE_URL=http://127.0.0.1:$MP/v1 ${EXTRA:-} node "$H" "$1" 2>&1; }

out=$(run "call two tools please"); c=$?
[ "$c" = 0 ] && ok "two parallel tool calls: exit 0" || no "two parallel tool calls: exit" "got $c"
has "two parallel tool calls: both executed" "tools=2" "$out"

out=$(run "use object args"); c=$?
[ "$c" = 0 ] && ok "object arguments: exit 0" || no "object arguments: exit" "got $c"
has "object arguments: read ran" "tools=1 first=dir ." "$out"

out=$(run "use bad json"); c=$?
[ "$c" = 0 ] && ok "malformed JSON args: exit 0" || no "malformed args: exit" "got $c"
has "malformed JSON args: still answers" "tools=1" "$out"

out=$(run "use xml call"); c=$?
[ "$c" = 0 ] && ok "call written as XML text: exit 0" || no "XML text call: exit" "got $c"
has   "call written as XML text: the read ran" "tools=1 first=dir ." "$out"
hasnt "call written as XML text: markup never printed" "<function" "$out"

out=$(run "two text calls"); c=$?
[ "$c" = 0 ] && ok "two calls written as text: exit 0" || no "two text calls: exit" "got $c"
has   "two calls written as text: both ran" "tools=2" "$out"
hasnt "two calls written as text: markup never printed" "<function" "$out"

out=$(run "use tag call"); c=$?
[ "$c" = 0 ] && ok "<function=name>{json}: exit 0" || no "tag call: exit" "got $c"
has   "<function=name>{json}: the read ran" "tools=1 first=dir ." "$out"
hasnt "<function=name>{json}: markup never printed" "<function" "$out"

out=$(run "use json call"); c=$?
[ "$c" = 0 ] && ok "bare JSON call object: exit 0" || no "json call: exit" "got $c"
has   "bare JSON call object: the read ran" "tools=1 first=dir ." "$out"
hasnt "bare JSON call object: not echoed raw" '{"name":"read"' "$out"

out=$(run "prose json answer"); c=$?
[ "$c" = 0 ] && ok "answer starting with {: exit 0" || no "prose json: exit" "got $c"
has   "answer starting with {: printed as written" "is just a JSON object" "$out"

out=$(run "use unknown tool"); c=$?
[ "$c" = 0 ] && ok "unknown tool: exit 0" || no "unknown tool: exit" "got $c"
has "unknown tool: names the bad tool" "Unknown tool" "$out"
has "unknown tool: lists real tools" "Available: read, grep, man, web_search, web_fetch" "$out"

out=$(EXTRA="JERRITO_MAX_CHARS=1200" run "big read"); c=$?
[ "$c" = 0 ] && ok "big read + tiny budget: no hang" || no "big read + tiny budget" "exit $c (timeout?)"
has "big read + tiny budget: answered" "tools=1" "$out"

out=$(run "empty"); c=$?
[ "$c" = 0 ] && ok "empty response: exit 0" || no "empty response: exit" "got $c"
has "empty response: hint printed" "empty response" "$out"

out=$(EXTRA="JERRITO_STATS=1" run "plain question"); c=$?
[ "$c" = 0 ] && ok "plain question: exit 0" || no "plain question: exit" "got $c"
has "plain question: streamed content" "plain answer" "$out"
has "plain question: stats line when asked" "tok" "$out"

rm -f /tmp/mock-agent.log
out=$(EXTRA="JERRITO_STEPS=2" run "loop forever"); c=$?
[ "$c" = 0 ] && ok "tool-loop: exit 0" || no "tool-loop: exit" "got $c"
has   "tool-loop: answers after the tool budget" "forced answer" "$out"
hasnt "tool-loop: no 'stopped' shrug" "stopped: max tool steps" "$out"
reqs=$(grep -c . /tmp/mock-agent.log 2>/dev/null || echo 0)
[ "$reqs" = 3 ] && ok "tool-loop: 2 tool rounds + 1 forced completion" || no "tool-loop: completion count" "got $reqs"
has   "tool-loop: forced step ran without tools" "tools=no" "$(tail -1 /tmp/mock-agent.log)"

echo
echo "== parallel tool calls =="
# a slow fake 4get: it records when each search reaches it. Two searches that
# run in parallel arrive within milliseconds of each other; queued ones are
# separated by the full answer time.
FG_PORT=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{const p=s.address().port;console.log(p);s.close()})')
FG_LOG=/tmp/twosearch-times; : > "$FG_LOG"
cat > /tmp/mock-4get.mjs <<'FG'
import http from 'node:http';
import { appendFileSync } from 'node:fs';
http.createServer((req, res) => {
  appendFileSync(process.env.FG_LOG, Date.now() + '\n');
  // the title echoes the query, so the relevance check keeps the results
  const q = new URL(req.url, 'http://127.0.0.1').searchParams.get('s') || '';
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', web: [{ title: 'result for ' + q, description: 'd', url: 'https://four.example/' + Date.now() }] }));
  }, 300);
}).listen(Number(process.env.FG_PORT), '127.0.0.1');
FG
FG_PORT="$FG_PORT" FG_LOG="$FG_LOG" node /tmp/mock-4get.mjs & FG=$!
trap 'kill $MOCK $FG 2>/dev/null' EXIT
for i in $(seq 1 50); do curl -sf "http://127.0.0.1:$FG_PORT/api/v1/web?s=x&scraper=ddg" -o /dev/null && break; sleep 0.2; done; : > "$FG_LOG"

t0=$(date +%s%N)
out=$(EXTRA="JERRITO_4GET_URL=http://127.0.0.1:$FG_PORT JERRITO_BING=off JERRITO_SEARCH_HEDGE=5000" run "two searches"); c=$?
t1=$(date +%s%N); two_ms=$(( (t1-t0)/1000000 ))
[ "$c" = 0 ] && ok "two searches: exit 0" || no "two searches: exit" "got $c"
has "two searches: both tool results fed back" "tools=2" "$out"
n1=$(sed -n 1p "$FG_LOG"); n2=$(sed -n 2p "$FG_LOG")
if [ -n "$n1" ] && [ -n "$n2" ]; then
  gap=$(( n2 > n1 ? n2 - n1 : n1 - n2 ))
  [ "$gap" -lt 200 ] && ok "two searches: reached the provider together (${gap}ms apart)" || no "two searches: parallel" "${gap}ms apart"
else
  no "two searches: both requests seen" "log: $(cat "$FG_LOG" | tr '\n' ' ')"
fi
[ "$two_ms" -lt 1200 ] && ok "two searches: one round trip, not two (${two_ms}ms total)" || no "two searches: one round trip" "${two_ms}ms"

echo
echo "== summary: $pass passed, $fail failed =="
[ "$fail" = 0 ]