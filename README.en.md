# inemaccbot

**🇧🇷 [Português](README.md) · 🇺🇸 [English](README.en.md) · 🇪🇸 [Español](README.es.md)**

Telegram gateway + durable queue. Successor to `inemaccvbot`.

## 📖 User guide

Complete guide (landing page + step-by-step instructions): **https://inematds.github.io/inemaccbot/guia/en/**

Architecture map (diagrams of the bot, `promoavatar`, and `promoavatar3`, the configuration files, and where to change each thing): **https://inematds.github.io/inemaccbot/guia/en/arquitetura.html**

**Status: steps 0 to 5 complete, plus the domain workflows.** The queue is durable (SQLite in WAL mode, lease with heartbeat, drain, atomic claim), the gateway talks to Telegram, the skills run as agents (`transcrever`, `dublar`, `explicativo`, `curso`, `demo`, `reel`, `reelinematds`), and the workflow engine runs pipelines with state by phase and target, a frozen definition, a human gate, and resumption. v1 (`inemaccvbot`, `mkivideos`, `mkitexto`) is turned off.

What **intentionally does not exist**: a barrier between phases, job preemption, a global agent limit, multi-user support. See §11 of the spec — each item includes the trigger for reconsidering it.

**Plugging a new domain/skill into the bot?** Start with the **why** —
[`docs/integrar-um-repo.md`](docs/integrar-um-repo.md): why the bot knows the repo’s
PROFILE and not its code, why the scripts come in pairs (one expensive, using a
model, one cheap and deterministic), how input, output, and gates work, and the
failure-mode table documenting what has already gone wrong. Then, each route has
its own pair of scripts, and both include a manual step-by-step guide for background:

- **Skill** (one command, one artifact) → [`docs/plugar-por-manifesto.md`](docs/plugar-por-manifesto.md)
  — run `gerar-manifesto` once, `plugar-repo` on each machine.
- **Workflow** (phases with state and a gate) → [`docs/plugar-fluxo.md`](docs/plugar-fluxo.md)
  — run `gerar-manifesto-fluxo` once, `plugar-fluxo` on each machine. The manifest
  carries the definition and materializes it in the domain repo, **without overwriting**
  what is already there. Includes the VPS test procedure, known limits, and
  verification status. **New in 0.6.x, not yet used in production.**
- **Manual setup, with a real example** → [`docs/instalar-analisevideo.md`](docs/instalar-analisevideo.md)
  — both routes, step by step. Explains what the scripts automate.

## Installation (step by step)

From scratch to `/ping` responding on Telegram. Tested on Ubuntu with Node v24.

**Shortcut:** `./scripts/instalar.sh` handles steps 1 through 7 and stops where it
needs you (token, Claude login, CTA, HeyGen login), listing each pending item and
what breaks without it. `--checar` changes nothing; it only tells you what is
missing. `--sem-chromium` skips the ~400 MB download. It is safe to run again. The
steps below describe what it does — read them if you want to understand the process
or do it manually.

### 0. Prerequisites

| what | why | without it |
|---|---|---|
| **Node 22+** (`node -v`) | the process | won’t start. Ubuntu 24.04 ships with 18 — use the NodeSource 22.x repository |
| **`claude` on PATH, and LOGGED IN** | default engine for agent jobs (`src/fila/runner-claude.ts`) | the bot starts, but every agent job fails. Installed ≠ authenticated: check with `claude auth status` (expect `"loggedIn":true`) |
| **`ffmpeg`** | `ffmpeg.thumb` task and the audio/video for the skills | thumbnails and renders fail |
| **`python3` + `bash`** | the reel phase launches the standalone `montar-reel.py` | the `reel.montar` phase fails |
| **Playwright Chromium** | `scripts/heygen-estudio.mjs` (`chromium.launchPersistentContext`) | the `\| estudio` route fails. Run `npx playwright install chromium` — the Playwright version is pinned in `package.json` |
| **`sqlite3` (CLI)** | optional — manually inspect the queue (`select ... from jobs`) | only manual diagnostics are unavailable |

The database itself uses `better-sqlite3` (compiled by `npm install`), not the CLI.

`claude` is the **default** engine, not the only one: `codex` and `opencode` are
already registered as alternatives and can be enabled per job (`| motor=codex`),
per skill, or through `.env` — see [`docs/motor-codex.md`](docs/motor-codex.md) and
[`docs/motor-opencode.md`](docs/motor-opencode.md). A missing alternative engine
binary does **not** prevent startup; only jobs that request it fail.

**Playwright on a newly released OS (e.g., Ubuntu 26.04):** do not use `--with-deps`.
Its package list is OS-version-specific, and on a too-new OS it fails immediately —
that is what blocked installation on a 26.04 VPS. Download only the browser
(`npx playwright install chromium`). If Chromium will not start because a library
is missing, try `npx playwright install-deps`, knowing that it may not have
instructions for your OS either. In that case, the `playwright@1.57.0` pin is too
old for the machine, and you need to upgrade it — then test the `| estudio` route,
because it automates a UI and depends on timing. None of this affects the rest of
the bot: without Chromium, only the `| estudio` route is unavailable.

### 1. Clone and install

```bash
git clone git@github.com:inematds/inemaccbot.git ~/projetos/inemaccbot
cd ~/projetos/inemaccbot
npm ci            # `ci`, not `install`: reproducible installation from the lockfile
```

**Do not run `npm test` yet.** The suite only passes after step 2 — without the
domain repos, dozens of tests fail because `flow.json` is missing.

If `npm run build` says `tsc: not found`, `npm ci` skipped the devDependencies (which
is what `NODE_ENV=production` does automatically, common on servers). Rerun with
`NODE_ENV=development npm ci --include=dev`. The `npm audit` warning is noise from
transitive dependencies: do **not** run `audit fix --force`; it undoes the Playwright
pin.

### 2. Domain repos (siblings, not submodules)

`config/fluxos.json` declares the repos that workflows load from `PROJETOS_DIR`
(default: **the folder containing this clone** — the domain repos are siblings of
inemaccbot, so if you cloned everything side by side, you do not need to set the
variable, whether that is in `~/projetos`, `/root/projetos`, or `/opt`). They are NOT
included in the clone and are not submodules — clone both as siblings of this
directory:

```bash
cd ..   # the folder containing inemaccbot
git clone https://github.com/inematds/promoavatar.git
git clone https://github.com/inematds/promoavatar3.git
# the other catalog flows (only if you are going to use their command)
git clone https://github.com/inematds/musicavideo.git
git clone https://github.com/inematds/r7ex.git
git clone https://github.com/inematds/explicavideos.git
```

Without them, the bot starts, but dozens of tests fail and `/promoavatar` and
`/promoavatar3` break in the first phase.

### 3. The CTA (included in the clone since 2026-08-08)

`promoavatar` and `promoavatar3` require `cta/cta-9x16.mp4`. It used to be an
external asset — both repos ignore `*.mp4`, and the file was not included in the
clone, causing **2 tests to fail** on a new machine. It is now versioned in both,
through an explicit exception in their `.gitignore` (`!cta/*.mp4`): it is 60 KB and
the file cannot be regenerated.

```text
~/projetos/promoavatar/cta/cta-9x16.mp4
~/projetos/promoavatar3/cta/cta-9x16.mp4
```

**Nothing to do in this step** — just check that both paths exist after step 2. If
they are missing, your clone predates the change: run `git pull` in each repo.

Expected format: 1080x1920, H.264/`yuv420p`/30 fps, AAC 48 kHz stereo — the pipeline
concatenates without re-encoding when the parameters match.

### 4. Test and build

```bash
cd ~/projetos/inemaccbot
npm test           # now: 788/788
npm run build      # generates dist/index.js — the systemd unit runs from there, not from src/
```

### 5. Create the bot on Telegram

Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → it returns the token.
That value is `BOT_TOKEN` in step 6 — **never commit the file that contains it**
(see §`.env`).

### 6. Write `.env`

```bash
cp .env.example .env
chmod 600 .env
```

Fill in the five required values (full table in [`.env`](#env)) and replace
`/CAMINHO/PARA` with the real paths. Optional values have defaults derived from
`$HOME` — you can leave those lines out.

#### How to find your Telegram chat ID (you don’t need to know it in advance)

Leave `ALLOWED_CHAT_IDS=0` in `.env`. This is **pairing mode**: the bot does not
have an owner yet. Start it (step 7), open your bot on Telegram, and send `/ping`.

The first `/ping` it receives registers that chat as the owner: the bot confirms
the ID in its response, writes it to `ALLOWED_CHAT_IDS` in `.env` (only that line
changes — comments and the rest of the file stay intact), and **closes the door**.
The second chat to try is silently rejected.

Registration takes effect immediately, without a restart: the next message from
that chat can run a command normally.

**What this means, plainly:** while the allowlist is `0`, whoever sends `/ping`
first gets the bot. If the token leaked, or someone knows the bot’s @username, pair
it before leaving it running. Only `/ping` sent as text pairs the bot — attachments,
photos, and all other messages do not.

**Change the owner:** set `ALLOWED_CHAT_IDS=0` in `.env` again, restart
(`systemctl --user restart inemaccbot`), and send `/ping` from the new chat. To
allow more than one chat, edit the list manually: `ALLOWED_CHAT_IDS=111,222`.

Leaving `ALLOWED_CHAT_IDS` **empty** is not pairing — it is a startup error, by
design: the allowlist is the only barrier between the bot and all of Telegram, and
invalid configuration should stop the service immediately, not leave the door open.

### 7. Start — manually first, then as a service

Start it manually first, so you can see a loud startup failure if anything is wrong:

```bash
./start.sh       # logs to the screen; Ctrl-C shuts down normally (SIGINT → drain)
```

`start.sh` rebuilds if `dist/` is older than `src/`, and **refuses to start if the
systemd service is already running**: two processes using the same `BOT_TOKEN`
compete for `getUpdates`, causing the bot to miss messages intermittently — an
expensive symptom to diagnose. To bypass the refusal: `./start.sh --forcar`.

A healthy startup prints the lease recovery line
(`boot: recuperação de leases — requeued=N failed=M`). A configuration or migration
error stops the process right there, by design — read the message before changing
anything else.

As a **user** service (not a system service — the unit has no `User=` and targets
`default.target`):

```bash
mkdir -p ~/.config/systemd/user
cp deploy/inemaccbot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now inemaccbot
loginctl enable-linger "$USER"   # the service survives logout / starts on boot
```

The unit paths use `%h/projetos/inemaccbot` — if you cloned somewhere else, edit
`WorkingDirectory` and `EnvironmentFile`, but **not** `WantedBy`.

### 8. Verify

```bash
systemctl --user status inemaccbot   # active (running)
tail -f "$(grep ^LOG_FILE .env | cut -d= -f2)"
```

In chat: `/ping` responds, `/ajuda` lists the commands, `/fila` shows empty queues.
If `/ping` does not respond but the service is `active`, it is an allowlist issue —
go back to step 6.

### 9. Update later

```bash
./atualizar.sh                 # bot + domains, builds and restarts
./atualizar.sh --sem-restart   # updates and builds, without touching the service
./atualizar.sh --agora         # restarts even if a job is running (you assume the risk)
./atualizar.sh --sem-dominios  # bot only
```

**It updates the domain repos too** — and this is not just a convenience: the domain
contains `flow.json`, prompts, templates, and the reel engine. A new bot with an old
domain runs an old prompt and produces the wrong video, **with no startup error**.
The list comes from `config/fluxos.json`, the same source the bot reads. A domain
with local changes is **skipped**, never stashed: generated workflow text lives there.

It handles the steps you would have to remember to do manually, in this order: stash
local edits **in this repo** (including edits to `atualizar.sh` itself — if they
disappear, they are in `git stash list`), `git pull --ff-only`, `npm ci` **forcing
`NODE_ENV=development`** (otherwise the devDeps disappear and the build fails with
`tsc: not found`), `npm run build`, and only then restarts — **detecting** whether
the unit is a user or system service instead of assuming.

**Checking for an in-flight job is mandatory, which is why the script refuses to
proceed.** Restarting while a render is running kills the process with SIGTERM and
uses up one job attempt — see [`code 143`](#código-143-não-é-erro-do-agente--é-restart).
When this happens, the new code **is already built**: only the restart remains
pending.

**Clones from before 2026-08-08:** the script detects this and explains. On that
date, the repo was split and the public repo was reborn from an orphan commit —
clones from before then have no common ancestor with `origin`, and no `git pull`
will bring in the new code (the symptom is “I pulled and nothing changed,” with
`start.sh` simply missing). The script prints the migration steps with paths already
filled in, preserving `.env`, the database, and untracked files. The old history
remains in `inematds/inemaccbotx` (private).

### 10. On a VPS: where each file lives

The bot’s `.env` belongs in the **clone root**, and this is not a preference:
`main()` reads `resolve(process.cwd(), '.env')`, and the systemd unit uses
`WorkingDirectory` + `EnvironmentFile` pointing to the same folder. Cloned
somewhere else? Edit **both** unit lines to point to the same directory — if they
differ, systemd injects one `.env` and `main()` reads another, producing a confusing
symptom.

On a VPS running as `root`:

| file | who reads it | path |
|---|---|---|
| bot `.env` (**config**) | `main()` + systemd | `/root/projetos/inemaccbot/.env` (`chmod 600`) |
| **vault** (third-party secrets) | `HEYGEN_ENV_PATH`, `GROQ_ENV_PATH`, `IMG_ENV_PATH` | `/root/projetos/wifi/.env` (`chmod 600`) — the **default**, created by `scripts/instalar.sh` |
| Claude login | `claude` CLI | `/root/.claude/.credentials.json` (`chmod 600`) |
| HeyGen profile (`\| estudio` route) | `HEYGEN_PERFIL_CHROME` | `/root/.cache/inemaccbot/perfil-heygen` |

The domain repos (`promoavatar`, `promoavatar3`) have **no `.env` files**: they read
everything from the environment that the bot passes to child scripts.

**Material sources (`config/fontes.json`) — registered, not yet connected.** The
mirror image of the destination registry: a destination answers “where does the
artifact go”; a source answers “where does the material come from” (explanatory
video, track, b-roll). The domain requests by NAME (`trilhas`), and the bot knows
the path — today, the reel CTA is a path inside the domain, which is the kind of
thing that goes stale when changing machines. Two rules: **a source is a FOLDER**
and **file selection is EXPLICIT** (`lofi` → `trilhas/lofi.mp3`); ambiguous names
are rejected, never randomized — random selection would break “same request, same
result.” The file is **optional**: if absent, the registry stays empty.
`src/dominio/fontes.ts` is ready and tested, but **nothing consumes it yet** —
connecting it to chat and `flow.json` is the next step, and that will change
behavior.

**Two files, two roles** — confusing them costs time: the clone’s `.env` is the
bot’s CONFIG (`BOT_TOKEN`, `ALLOWED_CHAT_IDS`, paths) and must stay there;
`wifi/.env` is the third-party secret VAULT (`HEYGEN_API_KEY`,
`GROQ_API_KEY`, `GOOGLE_API_KEY`, `AGNES_API_KEY`), one file per machine,
never versioned and never copied by git. `scripts/instalar.sh` creates the vault
skeleton with `chmod 600` and warns which keys are empty — filling them in is up to
you.

#### `root` is not required — and a system user is more correct

Running as `root` is the short path on a VPS, and it is what
`deploy/inemaccbot-sistema.service` currently uses. It is not the right choice: the
bot runs agents that execute commands, and it does not need administrative
privileges. On a server doing more than running this bot, create a dedicated system
user:

```bash
sudo useradd --system --create-home --home-dir /srv/inemaccbot --shell /usr/sbin/nologin inemabot
```

**What changes when the user changes** — everything derived from `$HOME`, which is
where migrations tend to go only halfway:

| item | value with `root` | with a dedicated user |
|---|---|---|
| vault (`HEYGEN_ENV_PATH` default) | `/root/projetos/wifi/.env` | `<home>/projetos/wifi/.env` |
| Claude login | `/root/.claude/` | `<home>/.claude/` — **per user**, must be redone or copied with `chown` |
| Claude binary (`CLAUDE_BIN`) | `/root/.local/bin/claude` | the one in the new `$HOME`, or a system path (`/usr/bin/claude`) |
| Chrome profile (`\| estudio`) | `/root/.cache/inemaccbot/perfil-heygen` | `<home>/.cache/…` — the HeyGen session is per user too |
| clone, database, `state/`, logs | `/root/projetos/inemaccbot/` | wherever you clone it — files must be owned by the new user (`chown -R`) |
| `PROJETOS_DIR` | — | **does not change**: the default is the folder containing the clone, not `$HOME` |

And in the unit: update `User=`, `Group=`, `WorkingDirectory`, and `EnvironmentFile`
together. The classic gotcha is `%h`, which in a system service resolves to `/root`
**even when the service runs as another user** — that is why the system service uses
an absolute path, not `%h`. If the service’s `$HOME` is not what you expect, the
symptom is always the same: the vault “does not exist” and the key “disappeared.”

Doing this migration in the middle of an in-flight workflow loses work: `state/` and
the database change owners. Stop the service, check `/status`, migrate, and only then
start it again.

**VPS service: use the SYSTEM unit.** The user unit (`deploy/inemaccbot.service`)
assumes a session and linger — on a server, use
`deploy/inemaccbot-sistema.service`, which has `User=`, absolute paths, and the
`multi-user.target` target:

```bash
sudo cp deploy/inemaccbot-sistema.service /etc/systemd/system/inemaccbot.service
sudo systemctl daemon-reload && sudo systemctl enable --now inemaccbot
sudo systemctl stop|restart|status inemaccbot     # this replaces a "stop.sh"
sudo journalctl -u inemaccbot -f
```

Adjust `User=`, `WorkingDirectory`, and `EnvironmentFile` first — in system scope,
`%h` resolves to `/root` even when the service runs as another user, the classic
gotcha when migrating from a user unit. The two units **must not** run at the same
time with the same `BOT_TOKEN`.

There is a shortcut, and it is what the vault convention discourages: since `.env`
is published to the process environment (`exportarParaAmbiente`), you can put
`GROQ_API_KEY` directly in it and skip the vault. It works, at the cost of mixing
secrets with config in a file that pairing mode rewrites — prefer the vault and keep
`.env` for configuration.

**What changes between machines** (the rest of `.env` stays the same): `BOT_TOKEN`
— use a dedicated bot, or the two instances compete for `getUpdates` and each gets
half the messages; `ALLOWED_CHAT_IDS=0` to pair on the first `/ping`; `PUBLICO_URLS`,
which are local network names here and need to be the VPS IP/domain there; and
`HYPERFRAMES_BROWSER_PATH`, which points to a snap that the VPS probably does not
have (remove the line and the default applies again).

Claude and HeyGen logins **do not require a browser on the VPS** — both are files
and can be transferred with `scp`. The only difficult case is the `| estudio`
route, whose session runs into Cloudflare because of the IP; it is documented in
`doc/` (outside git).

## Configuration: what only YOU can provide

The bot cannot resolve any of this on its own — these are secrets, accounts, and
assets that live outside the repo. The right column says what breaks if something
is missing, so you do not discover it in the middle of a render.

| what | where | if missing |
|---|---|---|
| **Telegram token** | `BOT_TOKEN` in `.env` (BotFather) | startup fails immediately: `config: falta BOT_TOKEN` |
| **Chat allowlist** | `ALLOWED_CHAT_IDS` in `.env` — or `0` to pair on the first `/ping` (step 6) | empty stops startup. With the wrong ID, the bot is silent: every message appears as `rejeitada — fora da allowlist` in the log |
| **Claude login** | `claude auth status` → `loggedIn: true` | the bot starts and accepts commands, but **every agent job fails** — the most confusing failure to diagnose because everything *looks* right |
| **Claude binary** | `CLAUDE_BIN` (default `~/.local/bin/claude`) — **a path, never PATH**: systemd runs with a minimal PATH, and `claude` would resolve to the system `/usr/bin/claude`, which may be much older | startup refuses to proceed if the path does not exist. With an old CLI, the symptom is worse and silent: the agent asks permission for every `Write`, nobody responds, and the phase ends without writing any files (C#77 and C#78) |
| **CTA `cta-9x16.mp4`** | versioned in both domain repos, in `cta/` (step 3) | 2 tests fail, and no reel completes: the last phase concatenates the CTA at the end |
| **HeyGen Chromium profile logged in** | `HEYGEN_PERFIL_CHROME` (default `~/.cache/inemaccbot/perfil-heygen`) — you log in **once, manually**, in that profile | the `\| estudio` route fails. This is a path, not a secret: cookies are inside the folder, outside the repo |
| **Display for the `\| estudio` route** | `DISPLAY` in the service (here `:99`, the Xvfb from `stack99.service`) | HeyGen **blocks headless browsers**: it loads the logged-in app and overlays the login modal, and the phase reports “the session is not logged in on this profile” despite valid credentials. Without `DISPLAY`, the script falls back to headless — right on a VPS without Xvfb, wrong here |
| **HeyGen API key** | in the file pointed to by `HEYGEN_ENV_PATH` (default `~/projetos/wifi/.env`, the ecosystem’s only vault) — any file with a `HEYGEN_API_KEY=` line works; see `.env.example` | the `\| api` and `\| creditos` routes fail |
| **HeyGen CLI** | `heygen` binary on PATH, or the path in `HEYGEN_CLI` | same |
| **Final link server** | `PUBLICO_DIR` (served folder) + `PUBLICO_URLS` (URL bases) | the video is produced, but the message arrives without a download link. There are **two** URLs because the machine is on two networks at once |
| **Domain repos** | `promoavatar` and `promoavatar3` as siblings (step 2), plus `musicavideo`, `r7ex` and `explicavideos` for their commands | workflows break in the first phase |

General rule: **`.env` stores paths and IDs; third-party secrets live in their owner’s
file.** That is why the HeyGen key was not copied here.

On a machine where that “owner’s file” does not exist — a VPS, for example — it is
still recommended to use a dedicated file
(`~/.config/inemaccbot/heygen.env`, `chmod 600`) pointed to by `HEYGEN_ENV_PATH`.
If you prefer to combine everything, `HEYGEN_ENV_PATH` can point to the bot’s
**own `.env`** and the key can live there: it works without code changes, at the cost
of mixing secrets with config. `.env.example` includes both approaches.

## Using the bot in chat

### Service commands

| command | what it does |
|---|---|
| `/ping` | checks whether the bot is alive |
| `/ajuda` (`/help`) | **the summary** — the basics and how to get to the rest |
| `/ajuda tudo` | the COMPLETE command list (synonyms: `comandos`, `completa`, `all`) |
| `/ajuda <nome>` | help for ONE skill or workflow (`/ajuda promoavatar`) |
| `/skills` · `/fluxos` | the two catalogs |
| `/fila` | per queue: running, pending, age, errors in 24h, retried |
| `/espaco` | disk space used by each area (bot × skills), shown separately |
| `/status` | OPEN workflows: a one-line list (number · status · subject), followed by phase × target details for each |
| `/completos` | completed workflows, newest to oldest |
| `/jobs` | the job queue: what is running and what has finished |
| `/status j13` · `/status A#9` | details for a JOB or a WORKFLOW |
| `/cancelar j13` · `/cancelar A#9 [público]` | same |
| `/refazer j13` · `/refazer A#9 [público]` | same — for workflows, resumes from the failed phase |
| `/furar j13` | moves a pending job to the front |
| `/pronto [ref]` | “I’m done with my part” — releases the gate. Synonyms: `/aprovar`, `/aprovado`, `/ok` |
| `/limpar <escopo>` | see below |

**Help has two levels, and the short one is the default.** The complete list is over
30 lines with the skill catalog included — a whole phone screen for someone who
just wanted to release a gate. `/ajuda` gives the basics and shows both ways to get
details; `/ajuda tudo` still returns everything.

**Workflow reference:** `A#9`, `a#9`, `A9`, and `a9` all mean the same thing. A
number by itself (`13`) is always a JOB. In the list, a job appears as
`j13 · A#9/jovens` — the `j` distinguishes it from a workflow ID, and the suffix
shows who the job belongs to.

**`/pronto` without a reference** releases the workflow when only one is waiting.
If there are several, it lists them. If none are waiting, it says so.

**Trailing punctuation on fields is trimmed.** `| sombra.` and `| alvos=a,b;` are
valid — a period at the end is a writing habit, not a usage error. The SUBJECT is
not trimmed: its punctuation is content, and a question subject (“is this good or
bad?”) depends on it.

### Remove a workflow from `/status`

The panel shows `running` and `failed` — the two states that still need something
from you. A failed workflow you do not plan to resume can be handled this way:

| I want to | command | what happens |
|---|---|---|
| just remove it from the list | `/cancelar A#9` | becomes `cancelado`, which appears in neither `/status` nor `/completos`. The workflow still exists: `/status A#9` shows everything |
| delete it permanently | `/limpar A#9` | removes the workflow and its artifacts from disk. Shows what will be deleted and only proceeds with `confirmar` |

`/cancelar` interrupts pending and running jobs — a workflow that already failed has
none, so “0 job(s) interrupted” is correct, not an error. Anything already created
OUTSIDE the pipeline (a studio render, a file delivered to the channel) remains
there: canceling affects the pipeline, not the world.

### `code 143` is not an agent error — it is a restart

`claude exited with code 143` means `128 + 15` = **SIGTERM**: the process was
killed when the service shut down, in the middle of its work. The cause is almost
always a `systemctl --user restart inemaccbot` while a job is running.

What happens to the job depends on how many attempts remain: if an attempt is
available, it is **requeued** and the next startup resumes it automatically; with
no attempts left, it becomes `failed`. A reel render takes 10–15 min, so two
restarts in a row use up both attempts for the same job — that is how
`C#13/jovens-aut/reel` died, after the two restarts on 2026-08-01.

**Before restarting, check the queue:**

```bash
sqlite3 inemaccbot.db \
  "select id,fila,tarefa,status,flow_ref from jobs where status in ('queued','running');"
```

Empty → restart freely. With a render in progress → wait, or accept using up one
of its attempts. Then just run `/refazer A#9 <alvo>`: SIGTERM does not corrupt
anything; the work simply did not finish.

### Skills (one step, no state)

```
<skill>: <input> [| field]*
```

| example | |
|---|---|
| `transcrever: https://…` | audio → text |
| `dublar: https://… \| lives3` | and delivers it to the channel |
| `explicativo: <assunto> \| vertical` | 9:16 explainer video |
| `reel: /caminho/avatar.mp4 \| lives3` | stacked reel |
| `historia: Era uma vez… \| nome=baloes` | story → narrated film (Agnes, US$ 0) |
| `imagem: uma raposa ruiva na neve \| ratio=16:9` | standalone image (Agnes, US$ 0) |

Generic fields: `livesN` (destination) · `modelo=haiku` · `esforco=high`. Skill-specific
fields are listed in `/ajuda <skill>`.

### Workflows (multiple phases, with state)

**`/r7ex <topic>`** (or `/rtex`, 0.24.11): r7ex viral reel with no human gate. Sheet +
automatic gates → r7ex production (avatar, assembly, reviewer) → channel queue.
Channel and "now" come from the text; the command counts as the avatar OK. `/r7ex help` explains.

**`/explicavideo <subject>`** (0.25.11): explainer video with Nei's avatar, 16:9, 9:16
or both, no human gate. Sheet → avatar on HeyGen → v2 visual → render and
publication to the channel (link in inemaytbot, file in v3). Format and channel come from the
text. `| portao` (also valid on `/r7ex`) stops to ask for approval. `/explicavideo help` explains.

All catalog flows, with prefix, phases and gate: [`docs/fluxos.md`](docs/fluxos.md).

```
/promoavatar <assunto> [--alvo=jovens] [| legenda=nao] [| versao=N] [| de=<fase>] [| sombra]
```

| option | default | |
|---|---|---|
| `--alvo=x` (repeatable) or `\| alvos=a,b` | all | only those audiences |
| `\| legenda=nao` | **on** | turns off reel captions (one word at a time, uppercase, accent on the keyword) — see `promoavatar/docs/legenda.md` |
| `\| api` · `\| creditos` · `\| estudio` · `\| navega` | none | who generates the avatar, and whose funds pay for it. **Only one per workflow.** With none, you record in the studio. See [`docs/rotas-de-avatar.md`](docs/rotas-de-avatar.md) |
| `\| versao=N` | 1 | changes the studio title’s `-vN` |
| `\| de=<fase>` | — | starts partway through (you already did the text and/or avatar) |
| `\| sombra` | — | shows the plan; does not enqueue anything |
| `\| sem-portao` | — | runs to the end without stopping for `/aprovar` — **but still sends to chat** whatever each phase declares in `portao.mostrar` |

The `|` and `--` forms can be used together. **A field written without either is
REJECTED** — it does not silently become part of the subject, which is how a
workflow once started with 12 audiences by mistake.

Full help for each workflow lives in the domain repo: `/promoavatar help`.

### Cleanup

```
/limpar A#8            artifact + avatars + published items from that workflow
/limpar promoavatar    all workflows of that type
/limpar artefatos 14   bot area, by age
/limpar tudo           artifacts + published items from known workflows
```

**Dry run by default**: without `confirmar` at the end, it only shows what would be
removed and how much space would be freed. Workflow filtering uses `flow_ref` in
the database, so cleaning one workflow while another is running is safe. The bot
only touches what IT published inside `~/projetos/output` — everything else belongs
to other projects.

## Adding a new domain

This is the design test: **a new domain should not require a line of code in the bot.**

**With scripts (route A), in two steps.** `./scripts/gerar-manifesto.sh <url>` runs
where a model is available: it reads the repo (including script code, where the
pitfalls are), proposes the parameters and marks what was **guessed**, lets you edit
them, and writes `config/integracoes/<nome>.json` + `prompts/<nome>.md` — versioned
so installation is the same on every machine. Run it **once per repo**.

`./scripts/plugar-repo.sh <nome>` applies an already reviewed manifest from
`config/integracoes/` — clones the sibling repo, checks binaries and vault keys,
validates the input with the BOOT validator before writing, shows the diff, and
stops; it only writes with `--sim`, and `--desfazer` restores. **No model in this
path**: `gerar-manifesto` reads the repo and decides the queue, timeout, and prompt,
once per repo. Without a manifest, it refuses instead of guessing.

And `./scripts/preparar-repo.sh ~/projetos/<repo>` does the same for one of **your**
repos, writing the manifest **inside it** (`integracao.json`): then any bot
installation can plug it in by name alone, without a local adapter.

→ **How all three work, field by field:**
[`docs/plugar-por-manifesto.md`](docs/plugar-por-manifesto.md).

> 📘 **Complete example, from clone to first job:**
> [**`docs/instalar-analisevideo.md`**](docs/instalar-analisevideo.md) — plug an
> external repo ([`analisevideo`](https://github.com/inematds/analisevideo)) using
> BOTH routes, with the fields each validator requires, the vault key, and the
> symptom → cause table for when startup refuses. The two sections below are the
> summary; the document is the step-by-step procedure to follow manually on a VPS.

### A SKILL (one step, no state)

**No agent when the skill only runs a command.** Declare `comando` (and
`kind: "function"`) instead of `prompt`, and the bot executes it — the same rule
as for the workflow route: use an agent where it thinks, a function where it only
types. That was the `analisevideo` case: it was paying a model to assemble a bash
line, and on 2026-08-21 the model sent the script to the background (the prompt
forbade it, in bold), ended the turn, and the job died without a contract, killing
the analysis too.

```json
{ "command": "analisevideo", "kind": "function", "repo": "analisevideo",
  "comando": "bash {{repo}}/analisevideo.sh analisa {{input}}",
  "artefato_exts": ["md", "json"], "aguarda_artefato": true }
```

Markers: `{{repo}}` and `{{input}}` (both required), `{{saida}}`, and the declared
`campos` — all quoted. With `aguarda_artefato`, the bot launches it detached and
watches, so the work survives a restart. What returns to chat is the ARTIFACT that
the domain printed on the last line (checked against `artefato_exts` and the
filesystem); without a recognizable line, the full output returns as a receipt —
completed work does not become a failure.

In the manifest, this is one line: `"sem_agente": true`, and the existing
`invocacao` becomes the command.


Use this when “run it again from scratch” is acceptable. It does not save progress
and has no `/status` of its own.

1. Write the prompt in `prompts/<nome>.md`. Use `{{input}}` (what the person asked
   for) and `{{saida}}` (where to save it). The agent’s last line must be
   `RESULT: <caminho>`.
2. Add the entry to `config/skills.json`:

   ```jsonc
   { "command": "minhaskill", "fila": "texto", "kind": "agent",
     "prompt": "prompts/minhaskill.md", "artefato_exts": ["txt"],
     "max_tentativas": 2, "timeout_segundos": 3600,
     "aceita_destino": false,
     "campos": { "vertical": { "tipo": "bandeira", "padrao": "não" } },
     "descricao": "o que ela faz", "exemplo": "minhaskill: assunto" }
   ```

3. **Help (optional):** `prompts/minhaskill.help.md`. Without it, the bot derives
   help from the registry — see “Documentation rule” below.
4. `npm test`. The registry is validated at startup: an invalid entry **stops the
   service**, by design — starting with a catalog we do not understand is worse than
   not starting at all.

A declared field must be used in the prompt, and a prompt variable must be declared —
there are tests for both.

### A WORKFLOW (multiple phases, with state)

Use this when throwing away partial work would be unreasonable. You get `/status`,
selective `/refazer`, resumption, and a frozen definition.

1. Create the domain repo (`~/projetos/<nome>`) with `flow.json` (and `prompts/` if
   any phase uses an agent).
2. `flow.json`: `nome`, `prefixo` (the `P` in `P#16` — unique per workflow), `versao_def`,
   `alvos` (each with whatever the domain needs: `canal`, `gatilho`…), and `fases`.
   Each phase: `id`, `escopo` (`fluxo` = one job for all, `alvo` = one per target), `fila`,
   `kind`, `tarefa`, `max_tentativas`, and optionally `prompt`, `comando`, `espera`
   (poll: `{intervalo, timeout}`), `entrega`, `portao`, and `pausa_apos` (human gate
   → `/aprovar`).
3. `tarefa` can only be: `cli.rodar`, `fluxo-agente`, `fluxo-navegador`,
   `heygen.baixar`, `heygen.gerar`, `heygen.gerar-creditos`, `heygen.estudio`,
   `reel.montar`, or the `command` of a catalog skill. Other names are rejected when
   loaded.

   **Rule: agent where it THINKS, function where it only types.** A phase whose only
   purpose is to assemble a command line is `cli.rodar` (`kind: function`), with the
   command declared in `comando` — then the plug step checks that the script exists
   during installation. A phase that writes text, makes decisions, or navigates
   remains an agent. musicavideo started with four agent phases to run its own CLI,
   and all four failed on the first real execution: invented binary in the prompt,
   redefined output contract, detached render killed by the job.

   ```json
   { "id": "plano", "kind": "function", "tarefa": "cli.rodar",
     "comando": "bash {{repo}}/musicavideo.sh plano {{input}} --bruto",
     "pausa_apos": true, "portao": { "mostrar": ["{{artefato:plano}}"] } }
   ```

   `comando` markers: `{{repo}}` (required), `{{input}}`, `{{alvo}}`,
   `{{ref}}`, `{{saida}}`, and `{{anterior:<campo>}}` — the last reads `campo: valor`
   from the previous phase’s receipt, which is how a value only the domain knows
   how to construct (a slug, for example) passes between phases. Unknown markers
   are rejected at load time; user text is always QUOTED.

4. **The gate belongs to the DOMAIN** (optional). `portao: { mostrar: [...] }` in a
   phase with `pausa_apos` specifies what goes to chat when it finishes: text is
   inline, audio and images are sent as files, and video is sent as a published link
   (minute-long mp4s exceed Telegram’s 50 MB limit). If undeclared, the old behavior
   applies — scripts in `textos/<REF>/<alvo>.md`, and the phase artifact as a fallback
   if no script exists.

   A template ending in `?` is OPTIONAL: if unresolved, continue silently. This is
   for materials that only sometimes exist — Suno delivers TWO tracks, but
   `--faixa-pronta` delivers one, and the second must not become an error warning in
   a workflow where it legitimately does not exist.

4b. **RESPOND to the gate** (optional). `portao.respostas` declares what users can
   say besides “yes”: a word mapped to a domain command.

   ```json
   "portao": {
     "mostrar": ["{{artefato:clipe}}"],
     "respostas": {
       "reprova": "bash {{repo}}/x.sh reprova {{anterior:slug}} clipe {{resposta}}",
       "ritmo": { "comando": "bash {{repo}}/x.sh recorta {{anterior:slug}} --ritmo {{resposta}}",
                  "reabre": false }
     }
   }
   ```

   `clipe: MVD#97 reprova 4,17,23` runs the command and REOPENS the phase with
   the new material — “revise it and show it to me until I approve.” `{{resposta}}`
   is the rest of the line, as a single QUOTED argument: the domain interprets it,
   as with `--bruto`. The bot does not know what “reject a clip” means, and should
   not.

   `reabre: false` is for actions that do NOT redo anything — choosing between two
   tracks that have already been generated just points to a different file, and
   reopening there would regenerate paid material; in that case the gate only
   resends what changed.

   This exists because the gate used to be one-way: `/aprovar` released it, with no
   way to go the other direction. Fixing a cover meant `/cancelar` — the whole
   workflow. And `/refazer` does not help, because it only targets failed phases.
5. Add to `config/fluxos.json`: `{ "command", "repo", "descricao", "exemplo" }`.
6. **Help (optional):** `HELP.md` in the domain repo root.
7. Check in SHADOW mode before spending anything:
   `/<fluxo> <assunto> | sombra` prints phase × target × queue × task and **does not enqueue anything**.

The domain says WHO it is for (channel by name, `lives21`); the bot knows WHERE it
is (the path on disk). Never put paths in `flow.json`.

#### The six avatar routes → [`docs/rotas-de-avatar.md`](docs/rotas-de-avatar.md)

Choosing who generates the avatar video and whose funds pay for it is a
per-workflow choice: `| api`, `| creditos`, `| estudio`, `| navega` — or none, in
which case you record in the studio. **Only one per workflow**; requesting two is
rejected at creation.

The decision is not trivial: cost depends on **authentication**, not on a
parameter — an API key charges the dollar wallet, OAuth charges subscription
credits. The document has details for each route, with measured costs and the real
status of each one.

Status summary (verified on 2026-08-09): the **normal** route is in production;
`| api`, `| creditos`, and `| estudio` are implemented but have **never run inside
a workflow**; `| navega` exists only in `promoavatar`, which is frozen.

### Documentation rule (verified by test)

**Every domain in the catalog provides help.** Not by discipline, but by design:

1. subject matter experts write it (`HELP.md` for a workflow, `<prompt>.help.md` for a skill);
2. if they do not, help is **derived from the registry** — phases, targets, fields,
   deadlines, prefix. The derived help cannot diverge, because it comes from the same
   source the bot uses to execute;
3. `src/gateway/ajuda-dominio.test.ts` scans both catalogs and **fails** if any domain
   does not provide usable help.

In chat: `/ajuda <nome>` for any item, or `/<fluxo> help`.

## Documents

This README answers one question: **what the bot is, how to install, configure, and
use it.** Everything else lives in its own document, linked here. If you find a long
detail buried in this file, that is an organization bug — open an issue or move it.

**The three documents that extend the README:**

- [`docs/rotas-de-avatar.md`](docs/rotas-de-avatar.md) — the six routes, measured cost, and
  the real status of each. Read before choosing `| api`, `| creditos`, or `| estudio`.
- [`docs/pipeline-e-custo.md`](docs/pipeline-e-custo.md) — why the reel phase stopped
  being an agent, where a workflow’s cost really is, and why captions are decided
  in the studio.
- [`docs/arquitetura.md`](docs/arquitetura.md) — startup, shutdown, queues, `function`
  tasks, conventions. For readers changing the code.
- [`docs/instalar-analisevideo.md`](docs/instalar-analisevideo.md) — plug an external repo
  ([`analisevideo`](https://github.com/inematds/analisevideo)) into the bot manually
  through both routes: catalog skill and domain repo. A template for any other
  integration.
- [`docs/integrar-um-repo.md`](docs/integrar-um-repo.md) — **why the manifest and
  plug scripts exist**: the bot knows the repo’s profile, not its code; the expensive
  half (model, once) and the cheap half (deterministic, on every machine); input,
  output contract, skill vs. workflow, gates, and failure modes already encountered
- [`docs/plugar-por-manifesto.md`](docs/plugar-por-manifesto.md) — the automated
  version of the above (route A): the `gerar-manifesto` (once, with a model) +
  `plugar-repo` (deterministic, on any machine) pair, the manifest schema, and what
  each validation prevents.
- [`docs/plugar-fluxo.md`](docs/plugar-fluxo.md) — same for route B (workflow): the
  `gerar-manifesto-fluxo` + `plugar-fluxo` pair, why the workflow manifest CARRIES
  the definition (a workflow does not fit on the bot side), the conflict rule that
  prevents overwriting the domain repo, and why the materialize → register order is
  non-negotiable. Also: **VPS test procedure**, symptom → fix table, what has and
  has not been verified, and limits of automatic design (the model collapses gates;
  `alvos` is always a guess).

**Switching the agent engine** (`claude` is the default, not the only one):

- [`docs/motor-codex.md`](docs/motor-codex.md) — run jobs through the OpenAI CLI
  (`codex exec`). Enabling it does not affect anything already running: `| motor=codex`
  on a job, then on the skill, and only then in `.env`. Covers what works and what
  **does not** (skills that say “Use skill X” are for Claude Code and fail silently
  on any other engine).
- [`docs/motor-opencode.md`](docs/motor-opencode.md) — same through the open
  `opencode` CLI, which works with Anthropic, OpenAI, Groq, DeepSeek, or a local model.
  **Runner has not yet been verified against the real CLI** — the document has the
  verification procedure and symptom → fix table.

**Domains** (audience, trigger, channel, prompt, template — none of that belongs to the bot):

- [`promoavatar3`](https://github.com/inematds/promoavatar3) — the **active** domain.
- [`promoavatar`](https://github.com/inematds/promoavatar) — **frozen** since
  2026-08-06; kept running, with no behavior changes.
- [`musicavideo`](https://github.com/inematds/musicavideo) — `/musicavideo`: phrase → music, cover and clip, with a gate at each phase.
- [`r7ex`](https://github.com/inematds/r7ex) — `/r7ex` and `/rtex`: 7-step viral 9:16 reel, no human gate.
- [`explicavideos`](https://github.com/inematds/explicavideos) — `/explicavideo`: explainer video with an avatar in 16:9, 9:16 or both, published to the channel, no human gate.
- All flows, with prefix, phases and gate: [`docs/fluxos.md`](docs/fluxos.md).

**History and analyses:**

- **Start here if resuming the project:** `docs/HANDOFF.md`
- Avatar through the API (`| api`) and optional gate (`| sem-portao`): `docs/fase-avatar-via-api.md`
- **Cost, time, and tokens per PHASE (A#19–A#29):** [`docs/custo-por-fase-a19-a29.md`](docs/custo-por-fase-a19-a29.md) — the measurements that led to making the reel phase a function and adding the `| estudio` route
- The `| navega` route (the agent in the studio), which `| estudio` replaces without deleting: [`docs/rota-navega-avatar.md`](docs/rota-navega-avatar.md)
- **Open conversations (resume):** `docs/conversas-abertas.md` — reel layout/templates, images, and token cost of the navigation phase
- Architecture: `docs/superpowers/specs/2026-07-30-inemaccbot-design.md`
- Execution profile (engine/model/effort): `docs/perfil-de-execucao.md`
- Plans: `docs/superpowers/plans/` (one step per file, 0 to 5 + promoclub, retired)
- Tests inherited from v1 and where each ended up: `docs/herdado-do-v1.md`
- External critique of the design (answered in §13 of the spec): `docs/analise_critica_inemaccbot_design.md`

Open analyses (what has not yet been decided):

- **Moving beyond Telegram — WhatsApp, email, or chatbot:**
  [`docs/analise-canais-alem-do-telegram.md`](docs/analise-canais-alem-do-telegram.md).
  The gateway seam already exists; what blocks it is `chat_id` being `INTEGER`.
  Recommendation: add, do not replace.
- **Image and link as workflow material:**
  [`docs/analise-imagem-e-link-como-material.md`](docs/analise-imagem-e-link-como-material.md)

## Code structure

```
src/
  db/           abrir.ts (SQLite + WAL), migrations.ts, backup.ts
  fila/         types.ts (Job/Perfil/Fila/ContextoTarefa), store.ts (FilaSqlite),
                runner.ts (Runner/Execucao contract), runner-claude.ts (claude engine),
                worker.ts (stepper: step/hit/drain/abort)
    tarefas/    CLOSED catalog of `function` tasks: http.ts (http.get), ffmpeg.ts
                (ffmpeg.thumb), index.ts (createTasks)
  dominio/      perfil.ts (resolveProfile — engine/model/effort; no production caller at
                this stage; added in step 2 with kind=agent)
  gateway/      telegram.ts (grammy adapter + allowlist + message splitting),
                comandos.ts (parses/executes commands, pure, no grammy),
                notificar.ts (job finished -> message in chat)
  config.ts     loadConfig — reads and validates the environment
  integracao/   tests that legitimately cross layers
  arquitetura.test.ts   checks boundaries between layers (now with gateway/)
  index.ts      startup, loop, scheduling, and shutdown — the heart of the process
```

## Development

```bash
npm install
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # tsc -> dist/index.js (dist/ is the tsconfig outDir, rootDir=src)
```

In production: `node dist/index.js` with `.env` in `WorkingDirectory` (see `deploy/inemaccbot.service`).

### `.env`

Variables read by `carregarConfig` (`src/config.ts`) — the first four are **required**;
without any one of them, startup fails loudly and early, before starting any worker:

| variable | required | default | purpose |
|---|---|---|---|
| `BOT_TOKEN` | yes | — | Telegram bot token (never commit the real value) |
| `QUEUE_DB` | yes | — | path to the SQLite queue file |
| `STATE_DIR` | yes | — | process state root; `STATE_DIR/midia` becomes the media root (see `ffmpeg.thumb` below) |
| `LOG_FILE` | yes | — | file where `main()` also writes each log line (in addition to stderr) |
| `ALLOWED_CHAT_IDS` | yes | — | comma-separated chat IDs; gateway allowlist |
| `MOTOR_PADRAO` | no | `claude` | fallback engine for the execution profile (step 2) |
| `MODELO_PADRAO` | no | `sonnet` | same, model |
| `ESFORCO_PADRAO` | no | `low` | same, effort |
| `HEYGEN_PERFIL_CHROME` | no | `~/.cache/inemaccbot/perfil-heygen` | **already logged-in HeyGen Chromium profile**, used by the `\| estudio` route. A path, not a secret — cookies live inside it |

`.env` stays out of git, with mode 600. The parser (`lerEnv` in `src/index.ts`) is
intentionally minimal (`KEY=value`, `#` for comments, optional quotes) — it is not
`dotenv`, just enough for startup. The process’s actual environment (systemd
`EnvironmentFile`, or a manual override) always takes precedence over what is in the
file when both define the same key.

**`.env` is also published to the process environment** (`exportarParaAmbiente`, called
by `main()`), not just read into `Config`. This is because phase scripts inherit the
bot’s environment (`reel.ts` does not pass `env:` to `spawn`), and without this
publishing the bot behaved inconsistently: under systemd, `EnvironmentFile` already
handled it, but child scripts could not see anything when started with `./start.sh`.
These variables are **not** read by `carregarConfig` — they are only passed through:

| variable | default | who uses it |
|---|---|---|
| `INEMAIMG_HOST` | `http://localhost:8000` | `gen-imagem.py` (reel images). On a VPS, tunnel to your home GPU: `ssh -R 8000:localhost:8000 <vps>` |
| `INEMAIMG_MODEL` | `flux2-klein` | same |
| `IMG_PROVEDOR` | `inemaimg` | image generator: `inemaimg` (local GPU, **seed respected**) or `agnes` (API, US$ 0, **no seed** — reel determinism is lost). `kie`/`fal` are rejected: not implemented |
| `IMG_ENV_PATH` | — | file with the provider key (e.g., `AGNES_API_KEY=`). Alternative: set the variable directly in the environment |
| `GROQ_ENV_PATH` | `~/projetos/wifi/.env` | `transcribe-groq.sh`. Alternative: `GROQ_API_KEY` directly in the environment, which takes precedence |
| `HEYGEN_API_KEY` | — | only if `HEYGEN_ENV_PATH` points to `.env` itself (see `.env.example`) |

## Architecture in operation → [`docs/arquitetura.md`](docs/arquitetura.md)

Startup (the order matters and is not arbitrary), what `drenar()` guarantees during
shutdown and what it does not, queues and concurrency, `function` tasks, code
conventions, and why `Worker` is a stepper rather than a service.

This is for anyone changing the code. The sections above are enough to install,
configure, and use it.
