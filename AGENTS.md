# Notes for whoever works on this next

(renamed from `helper`/`h` to `jerrito`/`j`: file, command, dirs, env prefix;
a stale `~/.cache/helper` is migrated on first run — see `migrateFromHelper`)

`jerrito` is a single-file CLI (`jerrito.mjs`) plus a flake (dev shell: node +
`llama-cpp-vulkan`) and an offline test suite in `test/`. Read this before
changing the prompt, the tool loop, or how the thing is packaged.

## Running things

```bash
nix develop -c ./test/run.sh        # all suites (needs the dev shell for llama-server)
SKIP_DOWNLOAD=1 ./test/run.sh       # skip the 1.5 GB model-download suite
nix develop -c j "question"         # dev shell wrapper always runs the live file
j --status                          # model server + which copy of jerrito.mjs is running
j --instances                       # 4get search instances in use (add: refresh)
```

## Packaging — flake outputs

| output | for |
| --- | --- |
| `packages.<system>.default` | `j` with GPU offload (Vulkan on Linux, Metal on macOS) |
| `packages.<system>.cpu` | `j` with the CPU-only llama.cpp |
| `apps.<system>.default` | `nix run . -- "question"` |
| `overlays.default` | `pkgs.j` / `pkgs.j-cpu`, built against the consumer's nixpkgs |
| `nixosModules.default` | `programs.jerrito.{enable,gpu,package}` |
| `devShells.<system>.default` | node + llama.cpp + a `j` wrapper in `.direnv/bin` |

Rules that keep this honest:

- The wrapper **must** export `JERRITO_PROG=h`: the packaged binary is a shell
  script that runs `node .../jerrito.mjs`, so node cannot see the name it was
  invoked as. Without it, usage and errors say `jerrito.mjs`.
- The module applies `overlays.default` itself, so `pkgs.j` comes from the
  consumer's pinned nixpkgs instead of dragging a second nixpkgs in.
- `hardware.graphics.enable` is set with `mkDefault` — a headless host must be
  able to override it (or pick `pkgs.j-cpu`).
- After touching the flake: `nix flake check`, then evaluate the module in a
  throwaway `nixosSystem` and assert `programs.jerrito.enable = true` puts `h`
  in `environment.systemPackages` (that is the only way to catch a broken
  `pkgs.j` reference — it fails at eval, not at build).

## Repo hygiene (git)

Tracked: `jerrito.mjs`, `README.md`, `AGENTS.md`, `LICENSE`, `flake.nix`,
`flake.lock`, `.envrc`, `.gitignore`, `.gitattributes`, `test/*.sh`.

- `flake.lock` **is the pin**. It floats on `nixos-unstable`; only move it on
  purpose (`nix flake update`), in its own commit, with the test suite green.
- Not tracked, and should not be: `.direnv/` (generated shell), `.pi/` (agent
  scratch), `result` (build output), `*.gguf`/`*.part` (1.5 GB of weights, they
  live in `~/.cache/jerrito/models/`).
- Nothing in the repo may depend on this machine: no absolute paths, no
  `/nix/store` scanning, no "it works because I have X installed". Tests must
  pass from a clean `nix develop`.
- The prompt and the renderer are the two things that regress silently; both
  have suites (`prompt-test`, `render-test`) — run them before touching either.

## The system prompt — invariants (this has regressed before)

1. **One definition.** All prompt text lives in `systemPrompt(interactive)` in
   `jerrito.mjs`. Nothing else may build, duplicate or hardcode it. Test:
   "exactly one prompt definition in the source".
2. **Instanced once per process, from live state.** `main()` computes
   `oneShot = question.length > 0` and calls `systemPrompt(!oneShot)`; the result
   becomes `messages[0]`. It is *not* read from disk, *not* cached in
   `~/.config/jerrito/config.json` or `~/.cache/jerrito/server.json`, and tool mode
   (`-t`) never builds one at all.
3. **Mode matters.**
   - one-shot (`h "q"`): "nobody will reply and there is no next turn …
     never ask a question, never offer to do more".
   - interactive (`h`): "the user sees your answer and can reply, and
     earlier turns are above".
   A session *does* keep history in the REPL; only the one-shot path is
   single-turn. If the model asks something back in one-shot mode, helper prints
   a hint pointing at the REPL.
4. **Per-invocation data must be fresh and local.** The prompt carries the date
   (**local** calendar, not `toISOString()` — UTC made it a day off for a UTC-3
   user, and the model then reasons about the wrong day), a **system line**
   (user@host, shell, distro from /etc/os-release, arch, cores, RAM — all free
   `node:os`/`/etc/os-release` reads, no subprocesses; without it the model
   suggests `apt install` on NixOS), the project root (git toplevel or cwd) and
   the top-level listing of that root.
5. **The command name comes from the invocation**, not from a constant:
   `PROG = JERRITO_PROG || basename(argv[1])` — usage, errors, the REPL banner and
   the one-shot hint say `j` when installed, `jerrito` when run as
   `node jerrito.mjs`. The wrappers (flake package + dev shell) export
   `JERRITO_PROG=h`. The prompt still says `You are "jerrito"`: that is the
   project, not the command.
6. **Keep it small.** The prompt is paid for on every request in a small
   context; it is ~1.5 k chars today and `test/prompt-test.sh` fails above 2000.

Tests: `test/prompt-test.sh` (31 assertions, offline — a stub server records the
system message, so it covers wording, mode detection, per-invocation freshness,
non-persistence and the one-shot hint).

## Stale builds: the "auto-loading" trap

`jerrito.mjs` is packaged by the flake as `pkgs.writeShellApplication`, which
**copies the file into `/nix/store` at build time**. Consequences:

| how you run it | which prompt you get |
| --- | --- |
| `nix develop` → `j` (shellHook wrapper) | the live working-tree file |
| `nix run .` | rebuilt from the working tree each time |
| `nix build` / `nix profile install .` | **frozen** copy — never updates until you re-run it |
| a REPL already running | the prompt it instanced at startup, until restarted |

A real example found in the store while debugging this:
`/nix/store/i2g6113qkg374f803xzfd36aqrk3cf5y-jerrito.mjs` — 1090 lines, no 4get
support, no mode-aware prompt; running it reproduced a symptom that had already
been fixed in the working tree.

Mitigation: `h --status` prints `source  <path>` and marks `/nix/store`
copies as `(frozen build — nix profile install . / nix build again to update)`.
If a fix "doesn't work", check that line first: you are probably running an old
build, or a session started before the fix.

## The server must not hold the GPU hostage

A detached model server nobody asks anything is a leak: ~2 GB of VRAM, held
forever, on a laptop you also play games on. Two independent guards, on purpose
(either alone would cover the ordinary case, together they cover the odd one):

1. **`llama.cpp` sleeps itself** — `serverArgs()` passes
   `--sleep-idle-seconds <JERRITO_IDLE|config.idleSeconds|300>`. After that long
   with no request the weights leave VRAM, the process stays warm, and the next
   request wakes it (measured ~0.7 s). No jerrito process involved, so it holds
   even if you never run `j` again. `JERRITO_IDLE=0` disables it.
   The flag only exists on recent llama.cpp builds and an unknown argument makes
   the server refuse to start, so `serverCaps(bin)` greps `llama-server --help`
   (~9 ms, once per cold start) and the flag is simply not passed on old builds.
2. **The watchdog** — `startWatchdog()` spawns `node jerrito.mjs --watch <pid>
   <base>` detached (log: `~/.cache/jerrito/watchdog.log`, pid kept in
   `server.json` as `watchPid`). Every 5 s it reads free VRAM (`nvidia-smi`, then
   amdgpu `/sys`, then `JERRITO_VRAM_FREE_MB` as a static override) and SIGTERMs
   the server when free VRAM is under `JERRITO_VRAM_FLOOR` (700 MB) *and* the
   server has been quiet for `JERRITO_VRAM_GRACE` (60 s) *and* `/slots` says it
   is not generating. `JERRITO_NO_WATCHDOG=1` skips it; a machine where VRAM is
   unreadable gets no watchdog at all. It exits when the server dies, and
   `--stop` kills it (`stopWatchdog`, guarded by a `/proc` cmdline check).

Decisions live in `underPressure()` — a pure function, so `idle-test` covers the
whole table (pressure, room to spare, busy, just used, VRAM unreadable) without a
GPU. Anything that adopts a server (`adoptExisting()`) also makes sure a watchdog
is alive, so a server started by an older jerrito is not left unwatched.

`j --status` prints the policy it will follow:
`sleeps after 300s idle · exits if free VRAM drops below 700 MB · watchdog 1234`.

## The footer

Every answer gets a dim footer line — `— 14.2 tok/s · 187 tok · search 0.8s ·
3 tools · 4.6s` — printed to **stdout, TTY only** (piped output must stay clean
markdown; that is asserted in `render-test`). Data sources:

- `complete()` sends `timings_per_token: true`; llama.cpp answers every SSE
  chunk with cumulative `timings`, and the last one (`predicted_n`,
  `predicted_ms`) is exact. A 400 that mentions `timings` flips a module flag
  (`askTimings`) and retries once without the parameter — other 400s still go
  to the context-overflow handler in `ask()`.
- Servers without timings: content deltas are counted (`reasoning_content` is
  not), ms is wall time between first and last content delta.
- `render.usage()` accumulates per completion (a turn can run several);
  `render.footer()` divides. Tool wall time is measured `tool()` → `toolResult()`
  per name (search/fetch). `JERRITO_STATS` still prints raw counts to stderr.

## Bugs that already bit us (don't reintroduce)

- **`nvidia-smi`'s trailing newline read as "0 MB free"** → the watchdog parsed
  `--query-gpu=memory.free` with `out.split('\n').map(Number)`, and
  `Number('')` is `0` — every reading looked like total VRAM exhaustion, so the
  watchdog killed an idle server exactly 60 s after every restart, and the
  second guard (`/sys`) returned 0 too because the amdgpu card (2 GB *shared*
  memory, `mem_info_vram_total = 0`) was counted as a real GPU. `parseSmFreeMiB`
  now drops blank lines and never coerces them, and cards with `total === 0` are
  skipped (shared/integrated memory is never "out of memory").
  `idle-test` parses the real formats and runs the watchdog against stubbed
  `nvidia-smi` output. If VRAM handling ever "kills servers too eagerly", read
  `~/.cache/jerrito/watchdog.log` first.
- **Watchdog polling `/slots` kept the server awake** → the first watchdog asked
  `/slots` every 5 s, and `/slots` is a *request*: the idle timer reset every
  time, so the server never slept and VRAM was never freed. The watchdog now
  checks the free-VRAM floor first and only asks `/slots` when a kill is
  otherwise justified. Keep it that way: any periodic request to a server you
  want to sleep defeats the sleep.

- **UTC date in the prompt** → wrong day for the user (fixed: local date).
- **Busy server judged dead** → `/health` does not answer during generation on a
  single-slot server; jerrito used to spawn a duplicate and could kill a live
  answer. Liveness is now `pid is alive`, `/health` is a hint.
- **Context overflow** → the template's tool block costs ~7k tokens; the server
  context default is 16k and a 400 `exceed_context_size` halves the history
  budget and retries once.
- **Half-pages** → trimming used to halve the *largest* tool result (invites
  invented facts); it now drops the oldest ones whole first.
- **Summary merged two reads** → `read README.md` and `read README.md:250-499`
  both rendered as one string and collapsed to `×2`; ranges are shown now.
- **A rotation step of 0** → `rotate()` advanced the cursor by
  `INSTANCES_MAX_TRY`; with only 2–4 instances, `(0 + 4) % 2 = 0` put the cursor
  back on the same start every time and the rotation was a no-op. It now steps
  by `max(1, min(INSTANCES_MAX_TRY, list.length - 1))`.
- **4get instance cache** → `rotate()` used to write the session-filtered list
  back (21 instances silently became 19), and remembering a working instance
  excluded the alternatives. It now only advances a cursor, keeps the full list,
  and prefers `lastGood` *plus* the rest.
- **Tool calls printed as text** → a small model sometimes writes the call as
  prose instead of using `tool_calls`: `<function name="read"><param
  name="path">x</param></function>`, `<function=read>{"path":"x"}</function>`,
  or a bare `{"name":"read","arguments":{...}}`. jerrito printed that markup as
  the answer. `parseTextCall()` now turns those into real calls, and the
  streamed answer holds its first characters back until it can tell prose from
  markup (flush as soon as it is not `<`/`{`, or after 700 chars).
- **Empty-answer notice erased** → printed before the panel collapsed, so the
  erase wiped it.
- **The tool panel drew itself twice** → `panel.erase()` gave up when the panel
  was taller than the terminal (`drawn > rows - 1`): it cleared `rows`, left the
  text on screen, and the next redraw printed a second copy below the first. A
  turn with ~18 tool calls did exactly that, so the same searches appeared twice
  before the answer. `capPanelRows()` now keeps only the newest `rows - 1` rows
  (min 3) *before* drawing, so the erase count always matches what is on screen;
  `erase()` no longer has a bail-out branch.
- **Markdown** → `**bold *italic* x**` printed raw markers; `\u0001` code
  placeholders leaked inside bold spans.
- **Code blocks printed as-is** → fenced blocks used to come out as literal
  triple-backtick lines with the code indistinguishable from prose.
  `styleFence()` now drops the backticks and draws a dim rail (`┌─ lang` /
  `│ code` / `└─`, blank lines keep the rail) — decoration only, so piped output
  is still the raw fence and `render-test` asserts both sides. `~~~` fences work
  too, and only the same marker with nothing after it closes a block (a longer
  fence or an info string inside one is content, as in CommonMark).
- **The rail walked rightwards with the code** → each code line re-added *its
  own* indent before the rail, so a block nested under a list item came out as a
  staircase (`   │ x` then `     │ y`). The rail is now pinned to the fence's
  indent and the code keeps only what it had beyond that: every line of a block
  shares one straight rail, and the closing `└─` lines up with `┌─`.
- **`##` titles kept their hashes** → a heading rendered as a dim marker plus
  bold text, which reads as "not matched at all". The markers go now (leading
  indent and a trailing `##` are tolerated, so the `##` a list item indents by
  also matches) and the title is bold; inline markup inside a title still styles.
- **Tables were passed through raw** → `| Step | Owner |` printed as pipes and
  dashes. `styleTable()` aligns the columns (widest cell per column,
  `:--`/`:-:`/`--:` honoured, indent kept), bolds the header and rules it off
  with a dim `──┼──` line, with `│` between cells and no outer bars. Alignment
  needs the whole table, so rows are buffered (`styleMdLine` returns `null` for
  one) and flushed when the table ends — including at the end of an answer, via
  `mdStream().end()`. Rows must have surrounding pipes, so `ls | grep | wc` in
  prose stays prose; piped output is untouched (`COLOR` false short-circuits
  before any buffering).
- **A wide table was dumped as unaligned pipes** → the first version had a
  "wider than the terminal" fallback that printed the rows raw, which is exactly
  what the table was supposed to fix: a real answer (three providers, a
  paragraph of pricing per cell) printed as a 400-column wall. Now
  `fitWidths()` shrinks columns water-fill style (narrow ones keep what they
  need) and `wrapCell()` wraps each cell inside its column, markup spans kept
  whole, stacking the physical lines of a row — so the grid survives, every
  line fits `COLS()`, and the rule lands after the header's last line. The
  first row is the header even when the model forgot the delimiter row (bold +
  rule; a one-row block gets neither).

## Tools (five)

| tool | shape / limits |
| --- | --- |
| `grep` | regex (with `|`) over project files, optional `path` + `glob`; own walker (`walkFiles`), skips `SKIP` dirs, ignores binaries and >1.5 MB files, 60 matches, invalid regex falls back to literal |
| `read` | one file with `offset`/`limit` (default 250 lines) or a directory listing; sandboxed to `ROOT`; `outline: true` gives a ctags symbol index (Markdown headings for `.md`) with line numbers, heuristic fallback when ctags is absent/no-parser/stalled; a whole-file read (no offset) of a >270-line file **returns the outline instead of the body** — the 2 B model will page big files even when told not to, so it cannot pay for what it is not given |
| `man` | system man page: `man -s SEC PAGE` as two exec args (no shell, option-looking names rejected), MANWIDTH=100, groff escapes stripped, capped at CFG.chars/2; exit 16 → honest no-entry + best-effort `man -k` suggestions |
| `web_search` | provider chain, see below |
| `web_fetch` | readable text from a URL, see below |

No shell tool, by design: a 2 B model must not be able to run anything, and the
schema is part of the prompt budget. Tools cost routing accuracy, so each one
earns its place by answering something the others cannot: grep/read = this
project, man = installed commands, web = the rest of the internet. Extend a tool
before adding one (`grep` carries `path`/`glob` rather than being two tools). The prompt tells the model to grep first and read only the lines it
finds; `prompt-test` asserts that wording exists.

### Calls in one turn run in parallel

All five tools are reads, so `ask()` runs a turn's tool calls **at the same time**
(`CFG.parallel` / `JERRITO_PARALLEL`, default 5 per batch — a model that spams
searches must not open twenty sockets). Results are fed back in the model's own
order, not the completion order, because history is what the next completion sees.
Consequences to keep in mind:

- `render.tool()` returns an id and `render.toolResult(text, id)` takes it; the
  panel prints every `⚙` line first, then each `→` as it lands.
- the footer's per-tool time is a **union of intervals** (`spans` in the
  renderer), not a sum, so two overlapping searches show as `search 0.4s`, not
  `0.8s`. `render-test` pins that through a pty.
- `JERRITO_STATS=1` prints `[N of M tool calls at once: names]` per batch, which
  is how you tell a batching problem from a plumbing one.
- a subagent-style "one slow tool blocks everything" is gone: a dead search and a
  fast grep finish in one round.

**The model must also be told to batch.** llama.cpp *renders* multiple
`tool_calls` fine, but a 2 B model often writes its second call as prose
(`web_search(...)` and then more text) instead of a second call. Rule 11 in the
prompt says so, and `parseTextCalls()` recovers those too: it takes **all** calls
written as text — `<function=read>…`, `<function=read>{…}`, bare `{"name":…}` —
not just the first, separated by newlines, `and`/`then`, or a JSON array of call
objects. `agent-tests` covers the multi-call-as-text case. If batching rates look
low, probe with `JERRITO_STATS=1` before touching the parser: the prompt is where
this has regressed before.

## Search topology

`web_search` **races** providers; it does not walk a chain. The first non-empty
answer wins and every other request is aborted (`raceWave` + `firstNonNull`,
`AbortController` shared by a wave, `httpFetch` keeps its own timeout *and* the
wave signal via `AbortSignal.any`):

1. wave 1 — **4get** (JSON API, scrapes from its own IP, so it bypasses our rate
   limiting; its candidate instances race each other too) and your **SearXNG**
   if `JERRITO_SEARX_URL` is set;
2. **hedge** — **Bing** (`&format=rss`: same results as bing.com as XML, ~340 ms,
   no bot wall) and DDG lite are wrapped in `hedged(SEARCH_HEDGE, …)` (default
   600 ms), so a healthy 4get means neither is contacted — our IP stays clean —
   but a slow instance cannot hold the search;
3. wave 2 — only if wave 1 was empty: DDG html + Brave, in parallel.

Timeouts (`JERRITO_SEARCH_TIMEOUT`, `JERRITO_4GET_TIMEOUT`, `JERRITO_SEARCH_HEDGE`)
only bound the *failure* path; with racing they never add to a successful search.
Anti-bot pages and 429s are reported as `rate-limited`, never as "no results".
`JERRITO_BING=off` drops Bing. Public SearXNG/4get instances are often behind
Anubis proof-of-work walls.

Engines that were measured and rejected (2026-11): Mojeek (captcha), Qwant lite
(JS shell, no result markup), Ecosia (403), Startpage and public SearXNG
instances (Anubis), Yahoo (500), Yandex (captcha). Bing's *HTML* page is also
useless (`li.b_algo` present, links rendered by JS) — only its RSS works. Do not
add a provider without checking that its markup is server-rendered.

**Relevance check.** Every provider's answer goes through `relevantRows(queryTokens,
rows)` before it can win: an unreliable source sometimes returns a full feed for a
different query (Bing RSS does it every few queries — "Siete Lunas", "Summer
Place Apartment Homes" for a sqlite/geography query), so if no row mentions one
of the query's meaningful words, the answer is discarded as junk and the race
continues. Stopwords are filtered out first (`STOPWORDS`) — otherwise the word
"the" makes any Spanish lyric page "relevant". Rows are kept whole, never
filtered one by one, so a legitimately rephrased result survives. `fetch-test`
pins both sides (junk dropped, filler-only query still gated).


Never put these back in series: a sequential chain of five providers with 6–20 s
timeouts is how a single search took 17 s. Two other traps:

- an aborted request is **not** evidence that an instance is bad — `search4get`
  checks `signal.aborted` before `fourgetBad.add(base)`, otherwise racing would
  poison the instance list;
- a mocked `fetch` in tests must keep the event loop alive while "hanging" (a
  `setTimeout` that is cleared on abort), or node exits on an unsettled await
  instead of exercising the timeout.

`web_fetch` picks the block that looks like prose (paragraph text up, link text
down), strips chrome by class/id, drops link-only tables, flattens card links to
`headline — url`, and says so when a page is an index or JS-rendered instead of
returning navigation as content.

`web_fetch` picks the block that looks like prose (paragraph text up, link text
down), strips chrome by class/id, drops link-only tables, flattens card links to
`headline — url`, and says so when a page is an index or JS-rendered instead of
returning navigation as content.

## Test suites

| suite | covers |
| --- | --- |
| `jerrito-tests` | tool shapes, error paths, offline search parsing, cold/warm start, `--status`/`--stop`, symlink install, REPL |
| `prompt-test` | the prompt: modes, freshness, non-persistence, size, source identity |
| `agent-tests` | tool loop vs a scripted server: parallel calls (two searches run together and reach the provider within milliseconds), bad args, unknown tool, budget-forced answer, empty response |
| `render-test` | markdown styling (headings, fenced code rails, aligned tables) + panel collapse through a real pty (`script`) + the footer counting overlapping tool calls once |
| `fetch-test` | `web_fetch` extraction fixtures; SearXNG / 4get / Bing-RSS parsing and fallbacks; provider racing (a hung scraper adds no latency, the hedge is not contacted when 4get is fast, a dead search is bounded) |
| `instances-test` | 4get instance auto-update: finder, cache TTL, overrides, self-heal, rotation |
| `idle-test` | `--sleep-idle-seconds` only on builds that know it, `JERRITO_IDLE=0`, `underPressure()` table, and a real watchdog against a fake `llama-server` (kills under pressure; leaves room, recent activity and a generating server alone) |
| `concurrency-test` | two simultaneous cold starts, busy-server reuse |
| `abort-test` | SIGINT mid-generation |
| `provision-tests` | model discovery, real download, cross-cwd reuse (throwaway `$HOME`s) |

All suites are offline except the live-search smoke test (skips itself when
providers rate-limit) and `provision-tests` (downloads a model unless
`SKIP_DOWNLOAD=1`).
