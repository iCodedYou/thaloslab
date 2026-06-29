# Thalos Lab — Build Decisions

> Resolves the open decisions in `SPEC.md` §16. This file is **authoritative** for these eleven points: where a decision below refines or overrides a default stated elsewhere in `SPEC.md`, this file wins. Read it alongside `SPEC.md` and `CLAUDE.md` before implementing.
>
> Resolved: 2026-06-28.

## Summary

| # | Decision | Pick |
|---|---|---|
| 1 | Backend language | TypeScript (unless team is Python-first) |
| 2 | ORM | Drizzle |
| 3 | Execution modes | preview default · `--live` executes · `--mock` for dev |
| 4 | GitHub coupling | local git required; GitHub = default optional remote |
| 5 | Dynamic agents | hybrid: templates + synthesis, clamped to least-privilege |
| 6 | `.thalos/` tracking | track agents + config; artifacts opt-in |
| 7 | Network posture | engineer = allowlist; read-only roles = none |
| 8 | Collab scope | brief + worktree + interface context pack; secrets stripped |
| 9 | OS sandbox | defer for v1, but ship it *with* collab |
| 10 | Desktop shell | browser-served now; Tauri later |
| 11 | CLI subcommands | later |
| 12 | Execution-mode scope | modes gate agent execution, not app operations |
| 13 | Daemon lifecycle + app dir | global `~/.thaloslab/`; lockfile + health-ping reuse; 127.0.0.1, fixed port w/ fallback |
| 14 | Global DB vs per-repo `.thalos/` | one global SQLite DB (index + state); `.thalos/` holds bytes/configs/worktrees |
| 15 | Monorepo tooling | pnpm workspaces; no Turborepo yet |
| 16 | Gate toolchain | Vitest + ESLint + `tsc --noEmit` + Prettier; aggregate `gate`; pre-commit hook |
| 17 | Provider detection cost | `detect()` never spends tokens (probe + zero-cost auth check) |
| 18 | GitHub degradation | local repo always created; GitHub create/push best-effort → local-only |
| 19 | Schema vs repositories | migrate full schema up front; build repositories only for tables a phase uses |
| 20 | Default daemon port | fixed `8473` with ephemeral fallback (4317 = OTLP, collides) |
| 21 | `shared` consumption | compiled to `dist/` and consumed compiled, not inlined from `.ts` source |

---

## Detail

### 1. Backend language — **TypeScript**

The daemon's real work is spawning and streaming subprocesses, a WebSocket server, git, and SQLite, all first-class in Node. End-to-end TypeScript lets `Ticket` / `AgentConfig` / `WorkflowMessage` be defined once in `packages/shared` and consumed by both daemon and web; Python would duplicate those types. The AI CLIs are Node-distributed, so an eventual in-process SDK path stays native. Reconsider only if you and the team are decisively more productive in Python — team velocity would outweigh the type-duplication cost.

### 2. ORM — **Drizzle**

~10 related tables with JSON columns that will churn across the build phases. Typed queries plus real migrations pay for themselves; Drizzle is lighter than Prisma (no heavy runtime/codegen step) and easy to rip out early if disliked.

### 3. Execution modes — **preview default · `--live` executes · `--mock` for dev**

Separate *cost* from *safety*.
- **Preview (default `thaloslab`):** orchestrator, triage, and planning run for real, so you see the actual plan, roster, and workflow it would use — but engineers/integrator do **not** execute and **nothing is written to the repo**. Inspect and approve before committing compute.
- **`--live`:** real provider invocation, real shell execution in worktrees, real diffs and merges.
- **`--mock` (dev-only):** fully stubbed providers, zero token spend, for testing the engine itself during development.

*Refines SPEC §3:* adds `--mock`; pins the meaning of the default as preview (real planning, no mutation).

### 4. GitHub coupling — **local git required; GitHub = default optional remote**

The engine only needs local git (worktrees, branches, merges). GitHub is a sync convenience; hard-coupling it adds an auth dependency and excludes GitLab / self-hosted / local-only users for no architectural gain. The from-scratch flow still defaults to "create + push to GitHub," with "local only" and "other remote" available.

*Refines SPEC §9:* GitHub is optional, not required.

### 5. Dynamic agents — **hybrid, clamped to least-privilege**

Ship a small curated template library for the common specialists (a11y, perf, docs, research, profiler, design-lead); synthesize for the long tail. Critically, **every synthesized agent is clamped to least-privilege by default** — `L0`/`L1` authority, `network: none`, `pathScope: own-worktree` — unless its task explicitly justifies more. An under-restricted synthesized agent is a security hole; the clamp is the load-bearing part.

*Refines SPEC §6:* synthesized dynamic agents default to least-privilege.

### 6. `.thalos/` tracking — **track `agents/` + `config.json`; artifacts opt-in**

Agent configs and project config are small, valuable, and reviewable, and should travel with the repo. Artifacts vary wildly in size and noise (raw diffs already live in git history; run logs are transient), so tracking them by default bloats the repo.
- **Tracked by default:** `.thalos/agents/`, `.thalos/config.json`.
- **Gitignored by default:** `.thalos/artifacts/`, `.thalos/worktrees/`, `.thalos/runs.log`.
- **Setting:** opt in to tracking decision-record artifacts only (specs, plans, threat models, audit findings) for teams that want that history versioned.

*Refines SPEC §10:* splits `.thalos/` tracking rather than tracking all of `artifacts/`.

### 7. Network posture — **engineer = allowlist; read-only roles = none**

| Role | Network |
|---|---|
| Engineer | allowlist (package registries + project-declared domains) |
| Reviewer | none |
| Test author | none |
| Security auditor | allowlist (registries / CVE sources) |
| Research agent | allowlist (web) |
| Integrator | allowlist |

Full network access is never a default for any role.

*Overrides SPEC §9:* the spec's stricter "engineer = none" breaks installing/updating dependencies mid-task; engineer defaults to allowlist instead.

### 8. Collab sharing scope — **brief + worktree + interface context pack; secrets stripped**

When a peer's CLI runs a task, the default context that leaves the host is: the task brief, the task's worktree, and an architect-designated **read-only context pack** of the interfaces/types the task depends on. Secrets and env files are always stripped. Whole-repo sharing is an explicit per-pool opt-in, and the host can always see exactly what is being sent. Too narrow (only touched files) starves the agent of needed types; too broad (whole repo) over-exposes — this is the balance.

*Sets the SPEC §11 default sharing scope.*

### 9. OS sandbox — **defer for v1, but ship it *with* collab**

For single-user local v1, the threat model ("an agent does something destructive") is already covered by worktree path-scoping, git recoverability (everything is reversible), the preview default, and the gates — so heavy containerization isn't worth the cross-platform complexity yet. But pooling executes in a lower-trust setting, so **OS-level sandboxing is a prerequisite that ships with or before collab (Phase 5), not Phase 6.** Do not ship pooling without it.

*Refines SPEC §15:* sandboxing gates Phase 5 rather than being a deferred Phase 6 item.

### 10. Desktop shell — **browser-served now; Tauri later**

Browser-served is what the concept specifies and far less work — no Rust toolchain, per-OS builds, or signing/notarization/auto-update machinery. Tauri buys a real native window, tray, and a signable distributable — all *distribution* concerns for shipping to others later, and the Tauri shell just wraps the same localhost UI, so deferring costs almost nothing.

*Confirms SPEC §4 / §15:* Tauri stays a Phase 6 option.

### 11. CLI subcommands — **later (post-v1)**

Non-interactive subcommands (`thaloslab ticket "…" --project x`) are a thin layer over the REST API and not needed to prove the product; the interactive menu, flags, and browser UI cover v1. Cheap to bolt on once the core is stable.

*Confirms SPEC §13.*

---

### 12. Execution-mode scope — **modes gate agent execution, not app operations**

The three modes (preview / `--live` / `--mock`) govern only *agent execution* — engineers writing code, the integrator merging branches, and any agent-run shell command. They do **not** gate user-initiated app operations: creating or importing a project, editing agent configs, and changing settings run for real in **every** mode, including preview. Preview's "no writes to the repo" means no *agent-driven* writes; the user setting up their own workspace is always real. Without this, a fresh user in the default preview mode couldn't even create a project — which would make the safe default useless.

*Refines SPEC §3:* pins what the modes gate.

### 13. Daemon lifecycle + global app directory — **`~/.thaloslab/`, lockfile reuse**

A single global app directory (resolved via a cross-platform paths library, conceptually `~/.thaloslab/`) holds the global SQLite DB, the daemon lockfile, logs, and user settings. The daemon binds `127.0.0.1` only, on a preferred fixed port with dynamic fallback if occupied, and writes `{ pid, port, startedAt }` to `~/.thaloslab/daemon.json`. On `thaloslab` launch: read the lockfile, health-ping `127.0.0.1:<port>/health` — if healthy, reuse it and just open the browser; if the lockfile is stale or the PID is dead, clean it up and start fresh. This makes "re-open the UI rather than start a second instance" (SPEC §13) concrete and crash-safe.

*Refines SPEC §3 and §13.*

### 14. Global DB vs per-repo `.thalos/` — **global state, per-repo bytes**

One **global** SQLite DB in the app directory holds all structured cross-project state — every SPEC §10 table, including artifact **index** records. Each project repo's `.thalos/` holds artifact **bytes**, the versioned agent-config files, and transient worktrees/logs; `artifacts.path` is relative to that repo's `.thalos/`. The git-tracked `.thalos/agents/` files are the portable source of truth; the DB is the queryable mirror, reconciled when a project is opened or imported. The DB can't live in a repo because it spans projects; the bytes can't live only in the DB because they must travel (and version) with the code.

*Refines SPEC §3 and §10.*

### 15. Monorepo tooling — **pnpm workspaces, no Turborepo yet**

pnpm workspaces manage the four packages at dev time with plain workspace scripts. No Turborepo until build/test times actually demand a task runner. This is a dev-time tool only and does not affect `npm i -g thaloslab` distribution (the published `cli`/`daemon` are bundled artifacts).

*Refines SPEC §4.*

### 16. Gate toolchain — **Vitest + ESLint + tsc + Prettier, aggregate gate, pre-commit**

Gates: Vitest (test), ESLint + `@typescript-eslint` (lint), `tsc --noEmit` (typecheck), Prettier (format). Publishable `cli`/`daemon` packages bundle with tsup/esbuild; `web` builds with Vite. A single root aggregate `gate` script runs typecheck + lint + test and is the definition of "green." Wire it as a pre-commit hook so the binding constraint "show passing gate output before done" (CLAUDE.md) is enforced mechanically.

*Refines CLAUDE.md Commands; fills the `<tbd>` toolchain.*

### 17. Provider detection cost — **`detect()` never spends tokens**

For every provider adapter (Claude now; Codex/Gemini later), `detect()` is a PATH/version probe plus a zero-cost auth/credentials check — never a billable model call. This is a hard contract on the adapter interface, so detection on daemon start and on demand is always free.

*Refines SPEC §5.*

### 18. GitHub degradation — **local repo always; GitHub best-effort**

When creating a from-scratch project, the local git repo is **always** created. GitHub create/push is best-effort and degrades automatically to local-only — with a clear "created locally; connect `gh` to push" notice — when `gh` is missing or unauthenticated, rather than failing or blocking. Reinforces the GitHub-optional stance of decision #4.

*Refines SPEC §9.*

### 19. Schema vs repositories — **full schema up front, repositories on demand**

Each phase migrates the full schema it introduces up front (the schema is the source of truth; Drizzle handles churn), but data-access repositories are built only for the tables that phase actually uses. Phase 0 migrates the entire §10 schema yet implements repositories for `projects` and `providers` only. Front-loading the schema avoids migration churn; deferring repositories avoids dead code for tables nothing reads yet.

*Refines CLAUDE.md How-we-build.*

### 20. Default daemon port — **`8473`, fixed with ephemeral fallback** (resolved during Phase 0)

The daemon's preferred port is `8473`, falling back to an OS-assigned ephemeral port if it's occupied; clients read the actual bound port from the lockfile. The initially-considered `4317` is the OpenTelemetry OTLP gRPC port and was found already bound on a dev machine — a poor default. `8473` is in an uncommon range. In dev, the daemon must hold the fixed port so the Vite proxy target is stable.

*Refines SPEC §3.*

### 21. `shared` consumption — **compiled `dist`, not inlined `.ts` source** (resolved during Phase 0)

`packages/shared` is compiled with `tsc` to `dist/` and consumed via its `exports` map (`import`/`default` → `dist/index.js`, `types` → `dist/index.d.ts`). Its relative imports carry explicit `.js` extensions so the emitted output is valid Node ESM. This **overturns the earlier Phase-0 plan assumption** that every bundler would inline shared's `.ts` with no runtime build: when `shared` is consumed as an external workspace package, Vite and the tsx loader resolve its internals with Node-ESM semantics and cannot resolve extensionless relative imports — they need real `.js` files. tsup (daemon/cli) tolerated source inlining, but Vite (web) and tsx (dev) did not, so consuming the compiled `dist` is the corrected, uniform approach. Consequence: `shared` must be built before the daemon/web/cli build or run; `pnpm build` builds it first and `pnpm dev` builds **and watches** it first.

*Refines SPEC §4 / §17 and CLAUDE.md Stack.*

---

## Spec refinements implied by these decisions

For the handoff, the points where this file supersedes a `SPEC.md` default:

- **§3** — add `--mock` dev mode; default mode is preview (real planning, no mutation); modes gate agent execution, not app operations (#12); global app dir + daemon lockfile lifecycle (#13); global DB vs per-repo `.thalos/` split (#14); fixed default port `8473` with ephemeral fallback (#20).
- **§4** — pnpm workspaces, no Turborepo yet (#15); `shared` built to `dist` and consumed compiled, not inlined from source (#21).
- **§5** — `detect()` never spends tokens (#17).
- **§6** — synthesized dynamic agents default to least-privilege.
- **§9** — GitHub optional, not required; engineer network defaults to allowlist (not none); local repo always created, GitHub create/push best-effort → local-only (#18).
- **§10** — track `agents/` + `config.json`; gitignore `artifacts/` + `worktrees/` + `runs.log` by default; one global SQLite DB holds all tables incl. artifact index, `.thalos/` holds bytes (#14).
- **§11** — default collab sharing scope = brief + worktree + interface context pack, secrets stripped.
- **§15** — OS sandboxing gates Phase 5 (ships with collab), not Phase 6.
- **CLAUDE.md** — gate toolchain pinned (Vitest/ESLint/tsc/Prettier) + aggregate `gate` + pre-commit hook (#16); migrate full schema up front, repositories only for tables a phase uses (#19).
