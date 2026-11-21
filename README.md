# helper

A stupid-minimal terminal helper for small local models. The command it installs
is **`h`** (the project is called helper; typing `helper` is not something you
should have to do).

> [!WARNING]
> **Vibe coded.** Nearly every line here was written by a language model in
> conversation with a human, in a "make it work, keep it small" spirit. It has
> tests (see [`test/`](test)) and they pass, but it was never audited, reviewed
> by a second engineer, or run in production. It downloads a language model to
> your machine and makes web requests on your behalf. Read it before you trust
> it, and expect rough edges.

```
$ h "what is this project?"

  ⚙ read .
  ⚙ read helper.mjs

helper.mjs is a single-file CLI that answers questions using three tools:
read (local files), web_search and web_fetch. It runs a small local model...
```

Three tools, no dependencies, one file. It is meant to run against a 1–4B model
on a laptop CPU and still be useful: explain a repo, find the right flag, tell
you what a command does, look something up on the web.

```
read         read a file (or list a dir) inside the current project
web_search   DDG lite scraper -> title / url / description only
web_fetch    curl + HTML -> markdown ("reading mode")
```

It has **no shell tool**. It cannot run commands — it prints them for you to run.
That keeps a small model from doing damage and keeps the tool schema tiny.

## Requirements

Either of these:

- **Nix** (recommended): `nix develop` — or `direnv allow` once — gives you
  Node 24, a GPU-capable `llama.cpp` (Vulkan on Linux, Metal on macOS) and a
  `helper` wrapper on PATH. Nothing else to install.
  `nix run . -- "question"` works without entering a shell, and
  `nix profile install .` puts the packaged `h` on your PATH.
- **No Nix**: Node 20+ with `llama-server` on PATH, or `HELPER_BASE_URL`
  pointing at a server you already run (ollama, LM Studio, another box).

Either way you never start the model server by hand: the first run finds the
binary, finds a tool-capable `.gguf` on the machine (or downloads one once),
starts it detached, and reuses it from then on.

## Usage

```bash
nix develop                       # node + llama.cpp + `h` on PATH
h "what is this project?"         # one-shot answer
h                                 # interactive shell (/reset, /help, /exit)

h --status                        # is the model server up?
h --stop                          # stop the server it started
h --instances                     # which 4get search instances it uses (add: refresh)
h -t web_search q                 # run one tool, print raw output (debugging)
h -t read .
h -t web_fetch https://nix.dev/

-m, --model <path|id>             use this .gguf (remembered) or model id
-u, --base-url <url>              use an existing server, never spawn
```

A one-shot answer is exactly one turn: the model is told there is no next turn,
so it will not ask you a follow-up. The shell (`h` with no arguments) *does*
keep the conversation, and `/reset` clears it.

Make it a normal command on your PATH:
```bash
nix profile install .                     # self-contained: node + llama.cpp + git -> `h`
```

Outside Nix (needs `llama-server` on PATH): `ln -sf "$PWD/helper.mjs" ~/.local/bin/h`
and `fish_add_path ~/.local/bin`.

## Install it in your NixOS config

The flake exposes `packages.<system>.{default,cpu}`, `overlays.default` and
`nixosModules.default`.

**Module** — installs `h`, enables GPU offload, and builds against *your*
pinned nixpkgs (no second copy of it):

```nix
{
  inputs.helper.url = "github:TheSmallTeaBoi/helper";

  outputs = { self, nixpkgs, helper, ... }: {
    nixosConfigurations.box = nixpkgs.lib.nixosSystem {
      modules = [
        helper.nixosModules.default
        {
          programs.helper.enable = true;        # -> `h` on PATH
          # programs.helper.gpu = false;       # don't enable graphics drivers
          # programs.helper.package = pkgs.h-cpu;  # CPU-only build
        }
      ];
    };
  };
}
```

**Overlay + plain packages** — same thing, no module:

```nix
{ inputs, pkgs, ... }:
{
  nixpkgs.overlays = [ inputs.helper.overlays.default ];
  environment.systemPackages = [ pkgs.h ];   # or: home.packages = [ pkgs.h ];
}
```

**No overlay** — simplest, but pulls this flake's own nixpkgs as a second copy:

```nix
environment.systemPackages = [ inputs.helper.packages.${pkgs.stdenv.hostPlatform.system}.default ];
```

The package wraps its own `node`, `llama-server` and `git`, so there is nothing
else to enable. GPU offload needs drivers: the module sets
`hardware.graphics.enable = true` with `mkDefault` (override it, or use
`pkgs.h-cpu` on a headless box). Models are still per-user, in
`~/.cache/helper/models`.

## How the model part works

On first use, in order:

1. **Server** — `llama-server` from `HELPER_BIN_DIR`, `~/.config/helper/config.json`,
   or `PATH`. No store scanning: on Nix, the dev shell puts it on PATH.
   It runs detached on a free port; pid/port/model are kept in
   `~/.cache/helper/server.json` and reused. Server log:
   `~/.cache/helper/llama-server.log`.
2. **Model** — `HELPER_MODEL_FILE`, then `~/.config/helper/config.json`, then a
   scan of `~/models`, `~/.local/share/models`, `~/.cache/llama.cpp` and the
   HuggingFace cache. A model is only auto-picked if its name looks like an
   instruct/tool-capable build; `.gguf` files that look like base/3D/vision/
   embedding weights are skipped, and anything under 400 MB is ignored.
3. **Download** — nothing suitable on disk? It fetches
   `Sharp-MiniCPM5-2B-Q4_K_S.gguf` (1.5 GB) once to `~/.cache/helper/models/`,
   with a progress bar. That model was the best small model at tool routing in
   testing, and its recommended sampling (`temp 1.0, top_p .95, top_k 20,
   min_p 0`) plus `--jinja` are applied automatically.
4. **Start** — two `helper` calls at the same time take a short lock, so they
   wait for one server instead of racing on the model download or starting two.
   `--stop` shuts it down; a crashed start leaves a lock that expires after 15
   minutes (an ordinary ctrl-c or crash clears it immediately).

### GPU

The dev shell uses nixpkgs' `llama-cpp-vulkan`, so any NVIDIA/AMD/Intel GPU is
used through Vulkan — no CUDA SDK, no rebuild, and it is in the binary cache.
helper starts the server with `-ngl 99`, so all layers offload when a backend
is present; a CPU-only llama.cpp just ignores the flag. On NixOS you need
`hardware.graphics.enable = true` for the Vulkan ICDs (this machine has it).

```bash
helper ...                     # all layers to the GPU (default)
HELPER_NGL=20 helper ...       # partial offload, when VRAM is tight
HELPER_NGL=0 helper ...        # force CPU
```

To use CUDA instead, swap `llama-cpp-vulkan` in `flake.nix` for
`llama-cpp.override { cudaSupport = true; }` (that one builds from source).

Everything is overridable in `~/.config/helper/config.json`:

```json
{
  "model": "/abs/path/model.gguf",
  "binDir": "/path/to/dir-with-llama-server",
  "context": 16384,
  "threads": 10,
  "gpuLayers": 99,
  "searx": "http://127.0.0.1:8888",
  "fourget": "https://4get.ca,https://search.m0e.space",
  "serverArgs": ["--jinja", "--flash-attn"],
  "preset": { "args": ["--jinja"], "sampling": { "temperature": 1, "top_p": 0.95, "top_k": 20, "min_p": 0 } }
}
```

Bring your own server instead (ollama, LM Studio, a remote box) and nothing is
spawned or downloaded:

```bash
export HELPER_BASE_URL=http://127.0.0.1:11434
export HELPER_MODEL=qwen2.5:3b
h "what does --impure do in nix develop?"
```

## Output

Thinking and tool calls are transient: they stream into a dim panel on stderr and
collapse into a single line as soon as the answer starts.

```
  thinking · 412 tok · check the flake first
  ⚙ read flake.nix
  → file flake.nix (37 lines)
  ⚙ web_search nixos-unstable llama-cpp-vulkan
  → 1) llama-cpp: init at 1.0.0
▸ read flake.nix · read README.md:120-180 · web_search "nixos-unstable llama-cpp-vulkan" · thought 0.4k · 4.2s

The flake pulls `llama-cpp-vulkan` from nixos-unstable, so ...
```

The summary keeps the *arguments* (file path, query, host) precisely so the
evidence is still visible after the panel is gone. Read ranges are shown too
(`read README.md:250-499`), so continuing a long file is distinguishable from
reading it twice — only genuinely identical calls collapse into `×2`.

The answer goes to stdout with light markdown styling: `**bold**` is bold,
`*italic*` is italic, `` `code` `` is cyan, headings/lists/links get markers and
underlines, fenced code is left alone (and styles nest, so `**text *with
italics* and `code`**` works). So this stays clean markdown:

```bash
h "how do I pin nixpkgs?" > answer.md
```

Piped output is unformatted markdown (no escape codes), `NO_COLOR` disables
styling, and `FORCE_COLOR=1` styles a pipe without any cursor movement.

If the model keeps calling tools instead of answering, `HELPER_STEPS` only
bounds the tool rounds: the last completion is sent with the tools removed and a
"answer with what you have" nudge, so a question always ends in an answer (or,
if the model still writes nothing, an explicit note saying so).

## Configuration

| env | default | what |
| --- | --- | --- |
| `HELPER_MODEL_FILE` | auto | .gguf to run |
| `HELPER_BASE_URL` | auto-spawn | existing OpenAI-compatible server |
| `HELPER_NO_SPAWN` | unset | `1` never starts a server |
| `HELPER_BIN_DIR` | auto | folder containing `llama-server` |
| `HELPER_SEARX_URL` | unset | your own SearXNG base URL (tried 2nd) |
| `HELPER_4GET_URL` | auto | 4get instance(s), comma separated; `off` disables |
| `HELPER_4GET_FINDER` | 4get repo | where the instance list is updated from; `off` freezes it |
| `HELPER_CTX` | `16384` | server context (the template's tool block is ~7k tokens) |
| `HELPER_NGL` | `99` | GPU layers to offload (`0` = CPU only) |
| `HELPER_TEMP` | model preset, else `0.2` | temperature |
| `HELPER_MAX_TOKENS` | `2048` | max answer tokens (thinking models need room) |
| `HELPER_TOP_P` / `_TOP_K` / `_MIN_P` / `_REPEAT_PENALTY` | model preset | sampler overrides |
| `HELPER_STEPS` | `8` | tool round-trips before a forced answer |
| `HELPER_MAX_CHARS` | `24000` | history budget (drops oldest turns) |
| `HELPER_SEARCH_RESULTS` | `6` | results per search |
| `HELPER_FETCH_CHARS` | `6000` | page text kept after markdown conversion |
| `HELPER_READ_LINES` | `250` | lines per file read |
| `HELPER_STATS` | unset | `1` prints token usage |

Sampler overrides are only sent when set, so servers/APIs that reject extra
fields are unaffected.

## Notes on the tools

**web_search** tries **4get** first (`https://4get.ca` and a mirror by default): a search
proxy that scrapes from *its* IP, so it keeps working when this machine's IP is
rate-limited. If 4get or its upstream engine is blocked it falls through to
SearXNG (if configured), then `lite.duckduckgo.com` (tiny HTML, no JS), then
`html.duckduckgo.com`, then Brave's HTML. Results are normalised to
`n) title / url / description`, deduped by host+path, and trimmed. When a
provider hands back its anti-bot page or an HTTP 429, the report says
`rate-limited` rather than pretending there are no results.

**web_fetch** fetches with a browser UA and picks the block that looks like
prose: paragraph text counts, link text is penalised, and among prose-like
containers the biggest wins (so a long article isn't cut to one section).
Chrome blocks are dropped by class/id, link-only tables go away, links that wrap
a whole card become `headline — url` instead of `[## headline…](url)`, repeated
lines are collapsed, and the text is converted to markdown (headings, lists,
code, emphasis) and truncated with a note saying how much was cut.

If the result is mostly links it says *"this looks like an index/homepage"*, and
if it is mostly navigation or a JavaScript shell it says *"little readable text
… try a raw/direct URL"* — both are more useful than returning chrome as content.

### Search that actually works

Public scraping is rate-limited by design: DuckDuckGo answers bursts with a 202
anti-bot page, Brave with 429, and public SearXNG instances (including
`search.mint.lgbt`) sit behind Anubis/Substation proof-of-work walls, so their
APIs are not usable from a CLI.

That is why 4get comes first: it is a proxy — one JSON request
(`/api/v1/web?s=…&scraper=ddg`), scraped from *their* IP. Instances come and go
(`4get.ca` was serving a 503 while this was written), so the instance list
**updates itself** from the project's own list — the `INSTANCES` array in
[`data/config.php`](https://git.lolcat.ca/lolcat/4get), which is exactly what
every instance's `/instances` browser renders:

```bash
$ h --instances
21 4get instances (0h old)  ← https://git.lolcat.ca/lolcat/4get/raw/branch/master/data/config.php
  https://4get.ca
  https://search.fischbytes.de
  …
```

- cached in `~/.cache/helper/4get-instances.json`, refreshed after 7 days
  (`h --instances refresh` forces it), or immediately when every instance
  in the list fails — that is the self-healing path;
- the instance that answered last is remembered (`lastGood`) and tried first, so
  a repeat search is a single request; the others rotate (`cursor`), so one dead
  instance does not starve the rest;
- instances that time out or bot-wall us are skipped for the rest of the session,
  and each instance is asked with `scraper=ddg` then `yandex`, because upstream
  engines get blocked independently of the instance being healthy;
- `HELPER_4GET_FINDER=<url>` points the updater elsewhere, `HELPER_4GET_URL`
  pins your own list and skips the finder entirely, `HELPER_4GET_URL=off`
  disables 4get.

`curl`-check an instance yourself with:

```bash
curl -s 'https://4get.ca/api/v1/web?s=nix+flakes&scraper=yandex' | head -c 300
```

helper reports `rate-limited` and moves on rather than pretending there are no
results.

For a backend that never depends on someone else's uptime, run your own SearXNG
and point helper at it — it is tried right after 4get, and both the JSON API and
the HTML page are understood:

```nix
# configuration.nix
services.searx = {
  enable = true;
  limiter = false;                     # it is local
  settings = {
    server.bind_address = "127.0.0.1";
    server.port = 8888;
    search.formats = [ "html" "json" ];
  };
};
```

```bash
export HELPER_SEARX_URL=http://127.0.0.1:8888   # or "searx": "…" in config.json
```

**read** is sandboxed to the git root (`git rev-parse --show-toplevel`, or cwd).
`..` escapes are rejected, binaries and >2 MB files are refused, directories
return a listing with file sizes, files come back line-numbered with an
`offset=` continuation hint when truncated.

**Context budget.** History over `HELPER_MAX_CHARS` drops whole old turns; if a
single turn is still too large (several fetched pages), the oldest tool results
are dropped whole before the newest one is truncated — a half page invites
invention, an empty one at least makes the model say so.

Reasoning models stream their chain of thought in `reasoning_content`; it is
printed dimmed so the terminal is not silent, and never stored in history.

## Verified with

llama.cpp **0.9.0** (bare binaries) and **1.0.0** (the version this flake's
dev shell provides), CPU only, 10 threads. Each of these ran the read / search /
fetch / dir-listing tests end to end:

- **Sharp-MiniCPM5-2B Q4_K_S** — the best of the three at tool routing, and the
  auto-download default. Answers in ~1s warm, ~8s cold, and reads the file
  before answering. Needs `--jinja` and its openbmb sampling preset, both
  applied automatically. Keep `min_p` at 0: llama.cpp's 0.05 default traps this
  model in repetition loops.
- **Qwen2.5-1.5B-Instruct Q4_K_M** — good at web_search/web_fetch, flaky at
  file questions (sometimes answers from memory instead of calling read).
- **A Qwen3.5-4B "thinking" fine-tune** — spends its whole token budget
  thinking unless `HELPER_MAX_TOKENS` is ~1500+, and ignores tools; this is the
  kind of file the auto-picker deliberately skips.

Rough context math: MiniCPM's chat template renders the three tool definitions
inline, so system + tools costs ~7k tokens before the question; a 16k server
context leaves room for a page of fetched text. Other models are far cheaper.
If a prompt does overflow, helper halves the history budget and retries once.

## Tests

```bash
nix develop -c ./test/run.sh   # everything, ~5 min (incl. a 1.5 GB download)
SKIP_DOWNLOAD=1 ./test/run.sh  # ~60 s, no download (inside the dev shell)
HELPER_TEST_MODEL=/path/x.gguf ./test/run.sh
```

The suites need `llama-server` on PATH; outside Nix use
`HELPER_BIN_DIR=/path/to/bin ./test/run.sh` or point at your own server.

| suite | covers |
| --- | --- |
| `helper-tests` | tool output shapes, error/edge cases (404, DNS, path escape, device file), offline search parsing (title/redirect/entities/dedupe/rate-limit), cold start, warm reuse, `--status`/`--stop`, symlink install, REPL |
| `prompt-test` | the system prompt: mode detection (one-shot vs shell), freshness, not persisted, size budget, which copy is running |
| `agent-tests` | agent loop against a scripted mock server: parallel tool calls, object arguments, malformed JSON args, unknown tool, big result under a tiny budget, empty response, tool-loop forced answer |
| `render-test` | markdown styling unit checks, and panel collapse via a real pty (`script`) vs piped output |
| `fetch-test` | `web_fetch` extraction on fixtures (prose vs card grid, boilerplate, index/thin notes, duplicate collapse) and SearXNG JSON / HTML / bot-check handling |
| `instances-test` | 4get instance auto-update: finder parsing, cache TTL, explicit/off overrides, self-heal when the whole list dies, rotation cursor |
| `provision-tests` | throwaway `$HOME`s: seeded cache, `-m <path>` remembered, real download byte-exact, cross-cwd reuse |
| `concurrency-test` | two `helper` calls at once → exactly one server, lock released |
| `abort-test` | `SIGINT` mid-generation exits 1 with "aborted", no crash trace |

Prompt invariants, the frozen-build trap and the test map are written down in
[`AGENTS.md`](AGENTS.md).

## Disclaimers

- **Answers can be wrong.** The model is 2 B parameters and quantised to 4 bits.
  It is told to say where an answer came from, not to be right. Verify anything
  that matters, especially commands, flags and versions.
- **`web_search` is scraping.** It goes through 4get (or SearXNG/DDG/Brave),
  which scrape other sites. Instances rate-limit, get blocked, and disappear;
  expect `rate-limited` instead of results sometimes. Respect the sites' terms.
- **`web_fetch` makes outbound requests** to whatever URL the model asks for,
  and sends those pages to the model. Do not point it at things you would not
  paste into a chat window.
- **First run downloads ~1.5 GB** of GGUF weights from Hugging Face into
  `~/.cache/helper/models/`.
- **It has no shell tool** by design: it prints commands, it does not run them.
  Still, a suggested command is just text — check it before running it.
- **No warranty.** See [`LICENSE`](LICENSE) (MIT).

## License

MIT. Do what you like with it; keep the copyright notice.
