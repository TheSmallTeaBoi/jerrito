# Notes for whoever works on this next

`helper` is a single-file CLI (`helper.mjs`) plus a flake (dev shell: node +
`llama-cpp-vulkan`) and an offline test suite in `test/`. Read this before
changing the prompt, the tool loop, or how the thing is packaged.

## Running things

```bash
nix develop -c ./test/run.sh        # all suites (needs the dev shell for llama-server)
SKIP_DOWNLOAD=1 ./test/run.sh       # skip the 1.5 GB model-download suite
nix develop -c h "question"         # dev shell wrapper always runs the live file
h --status                          # model server + which copy of helper.mjs is running
h --instances                       # 4get search instances in use (add: refresh)
```

## Packaging — flake outputs

| output | for |
| --- | --- |
| `packages.<system>.default` | `h` with GPU offload (Vulkan on Linux, Metal on macOS) |
| `packages.<system>.cpu` | `h` with the CPU-only llama.cpp |
| `apps.<system>.default` | `nix run . -- "question"` |
| `overlays.default` | `pkgs.h` / `pkgs.h-cpu`, built against the consumer's nixpkgs |
| `nixosModules.default` | `programs.helper.{enable,gpu,package}` |
| `devShells.<system>.default` | node + llama.cpp + an `h` wrapper in `.direnv/bin` |

Rules that keep this honest:

- The wrapper **must** export `HELPER_PROG=h`: the packaged binary is a shell
  script that runs `node .../helper.mjs`, so node cannot see the name it was
  invoked as. Without it, usage and errors say `helper.mjs`.
- The module applies `overlays.default` itself, so `pkgs.h` comes from the
  consumer's pinned nixpkgs instead of dragging a second nixpkgs in.
- `hardware.graphics.enable` is set with `mkDefault` — a headless host must be
  able to override it (or pick `pkgs.h-cpu`).
- After touching the flake: `nix flake check`, then evaluate the module in a
  throwaway `nixosSystem` and assert `programs.helper.enable = true` puts `h`
  in `environment.systemPackages` (that is the only way to catch a broken
  `pkgs.h` reference — it fails at eval, not at build).

## Repo hygiene (git)

Tracked: `helper.mjs`, `README.md`, `AGENTS.md`, `LICENSE`, `flake.nix`,
`flake.lock`, `.envrc`, `.gitignore`, `.gitattributes`, `test/*.sh`.

- `flake.lock` **is the pin**. It floats on `nixos-unstable`; only move it on
  purpose (`nix flake update`), in its own commit, with the test suite green.
- Not tracked, and should not be: `.direnv/` (generated shell), `.pi/` (agent
  scratch), `result` (build output), `*.gguf`/`*.part` (1.5 GB of weights, they
  live in `~/.cache/helper/models/`).
- Nothing in the repo may depend on this machine: no absolute paths, no
  `/nix/store` scanning, no "it works because I have X installed". Tests must
  pass from a clean `nix develop`.
- The prompt and the renderer are the two things that regress silently; both
  have suites (`prompt-test`, `render-test`) — run them before touching either.

## The system prompt — invariants (this has regressed before)

1. **One definition.** All prompt text lives in `systemPrompt(interactive)` in
   `helper.mjs`. Nothing else may build, duplicate or hardcode it. Test:
   "exactly one prompt definition in the source".
2. **Instanced once per process, from live state.** `main()` computes
   `oneShot = question.length > 0` and calls `systemPrompt(!oneShot)`; the result
   becomes `messages[0]`. It is *not* read from disk, *not* cached in
   `~/.config/helper/config.json` or `~/.cache/helper/server.json`, and tool mode
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
   user, and the model then reasons about the wrong day), the project root (git
   toplevel or cwd) and the top-level listing of that root.
5. **The command name comes from the invocation**, not from a constant:
   `PROG = HELPER_PROG || basename(argv[1])` — usage, errors, the REPL banner and
   the one-shot hint say `h` when installed, `helper` when run as
   `node helper.mjs`. The wrappers (flake package + dev shell) export
   `HELPER_PROG=h`. The prompt still says `You are "helper"`: that is the
   project, not the command.
6. **Keep it small.** The prompt is paid for on every request in a small
   context; it is ~1.5 k chars today and `test/prompt-test.sh` fails above 2000.

Tests: `test/prompt-test.sh` (31 assertions, offline — a stub server records the
system message, so it covers wording, mode detection, per-invocation freshness,
non-persistence and the one-shot hint).

## Stale builds: the "auto-loading" trap

`helper.mjs` is packaged by the flake as `pkgs.writeShellApplication`, which
**copies the file into `/nix/store` at build time**. Consequences:

| how you run it | which prompt you get |
| --- | --- |
| `nix develop` → `h` (shellHook wrapper) | the live working-tree file |
| `nix run .` | rebuilt from the working tree each time |
| `nix build` / `nix profile install .` | **frozen** copy — never updates until you re-run it |
| a REPL already running | the prompt it instanced at startup, until restarted |

A real example found in the store while debugging this:
`/nix/store/i2g6113qkg374f803xzfd36aqrk3cf5y-helper.mjs` — 1090 lines, no 4get
support, no mode-aware prompt; running it reproduced a symptom that had already
been fixed in the working tree.

Mitigation: `h --status` prints `source  <path>` and marks `/nix/store`
copies as `(frozen build — nix profile install . / nix build again to update)`.
If a fix "doesn't work", check that line first: you are probably running an old
build, or a session started before the fix.

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
  per name (search/fetch). `HELPER_STATS` still prints raw counts to stderr.

## Bugs that already bit us (don't reintroduce)

- **UTC date in the prompt** → wrong day for the user (fixed: local date).
- **Busy server judged dead** → `/health` does not answer during generation on a
  single-slot server; helper used to spawn a duplicate and could kill a live
  answer. Liveness is now `pid is alive`, `/health` is a hint.
- **Context overflow** → the template's tool block costs ~7k tokens; the server
  context default is 16k and a 400 `exceed_context_size` halves the history
  budget and retries once.
- **Half-pages** → trimming used to halve the *largest* tool result (invites
  invented facts); it now drops the oldest ones whole first.
- **Summary merged two reads** → `read README.md` and `read README.md:250-499`
  both rendered as one string and collapsed to `×2`; ranges are shown now.
- **4get instance cache** → `rotate()` used to write the session-filtered list
  back (21 instances silently became 19), and remembering a working instance
  excluded the alternatives. It now only advances a cursor, keeps the full list,
  and prefers `lastGood` *plus* the rest.
- **Tool calls printed as text** → a small model sometimes writes the call as
  prose instead of using `tool_calls`: `<function name="read"><param
  name="path">x</param></function>`, `<function=read>{"path":"x"}</function>`,
  or a bare `{"name":"read","arguments":{...}}`. helper printed that markup as
  the answer. `parseTextCall()` now turns those into real calls, and the
  streamed answer holds its first characters back until it can tell prose from
  markup (flush as soon as it is not `<`/`{`, or after 700 chars).
- **Empty-answer notice erased** → printed before the panel collapsed, so the
  erase wiped it.
- **Markdown** → `**bold *italic* x**` printed raw markers; `\u0001` code
  placeholders leaked inside bold spans.

## Tools (four, on purpose)

| tool | shape / limits |
| --- | --- |
| `grep` | regex (with `|`) over project files, optional `path` + `glob`; own walker (`walkFiles`), skips `SKIP` dirs, ignores binaries and >1.5 MB files, 60 matches, invalid regex falls back to literal |
| `read` | one file with `offset`/`limit` (default 250 lines) or a directory listing; sandboxed to `ROOT` |
| `web_search` | provider chain, see below |
| `web_fetch` | readable text from a URL, see below |

No shell tool, by design: a 2 B model must not be able to run anything, and the
schema is part of the prompt budget. Adding a fifth tool costs routing accuracy —
prefer extending an existing one (`grep` carries `path`/`glob` rather than being
two tools). The prompt tells the model to grep first and read only the lines it
finds; `prompt-test` asserts that wording exists.

## Search topology

`web_search` tries, in order: **4get** (JSON API, scrapes from its own IP —
bypasses our rate limiting; instance list auto-updates from the project's
`INSTANCES` array and is cached in `~/.cache/helper/4get-instances.json`) →
**SearXNG** if `HELPER_SEARX_URL` is set → DDG lite → DDG html → Brave.
Anti-bot pages and 429s are reported as `rate-limited`, never as "no results".
Public SearXNG/4get instances are often behind Anubis proof-of-work walls.

`web_fetch` picks the block that looks like prose (paragraph text up, link text
down), strips chrome by class/id, drops link-only tables, flattens card links to
`headline — url`, and says so when a page is an index or JS-rendered instead of
returning navigation as content.

## Test suites

| suite | covers |
| --- | --- |
| `helper-tests` | tool shapes, error paths, offline search parsing, cold/warm start, `--status`/`--stop`, symlink install, REPL |
| `prompt-test` | the prompt: modes, freshness, non-persistence, size, source identity |
| `agent-tests` | tool loop vs a scripted server: parallel calls, bad args, unknown tool, budget-forced answer, empty response |
| `render-test` | markdown styling + panel collapse through a real pty (`script`) |
| `fetch-test` | `web_fetch` extraction fixtures; SearXNG / 4get parsing and fallbacks |
| `instances-test` | 4get instance auto-update: finder, cache TTL, overrides, self-heal, rotation |
| `concurrency-test` | two simultaneous cold starts, busy-server reuse |
| `abort-test` | SIGINT mid-generation |
| `provision-tests` | model discovery, real download, cross-cwd reuse (throwaway `$HOME`s) |

All suites are offline except the live-search smoke test (skips itself when
providers rate-limit) and `provision-tests` (downloads a model unless
`SKIP_DOWNLOAD=1`).
