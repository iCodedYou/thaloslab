# Thalos Lab — Claude Code project guide

Local-first app that orchestrates the AI coding CLIs installed on the user's machine
(Claude Code, Codex, Gemini CLI, …) as a role-based engineering team that builds and
maintains software end to end.

- Authoritative spec: `docs/SPEC.md`
- Resolved build decisions: `docs/DECISIONS.md` — supersedes any conflicting default in `SPEC.md`

Read the relevant SPEC section before implementing each phase. Do not work from memory of it.

## Binding constraints — never violate (SPEC §2 + DECISIONS)

- **State lives in artifacts.** Anything that must survive a stage boundary is a file under
  `.thalos/`, indexed in SQLite. Agent context is scratch space.
- **Verification is the backbone.** build / typecheck / lint / tests are deterministic gates.
  Never report a task "done" without showing passing gate output. Never trust an agent's
  self-report of correctness — trust only gate output.
- **Minimize agent boundaries.** Add a role only for context isolation or adversarial
  independence; otherwise it is a mode of an existing role.
- **Single human interface.** The user talks only to the orchestrator. Approval gates sit on
  the plan and on risky/irreversible changes (auth, payments, data, migrations, infra).
- **Least privilege by default.** Synthesized/dynamic agents default to `L0`/`L1` authority,
  `network: none`, and `pathScope: own-worktree` unless the task explicitly justifies more.
  Engineer network = allowlist; reviewer and test-author = none. Full network is never a default.
- **Local-first.** Nothing leaves the machine without an explicit opt-in.

## How we build

- Implement **one phase at a time**, in `SPEC.md` §15 order (Phase 0 → 6). Do not start the
  next phase until the current one builds, all tests pass, and I have approved.
- Before a phase: enter **plan mode**, read the relevant SPEC sections, and present a plan for
  that phase only. Wait for my approval before writing code.
- Before declaring any task done: run build / typecheck / lint / test and show me the output.
  Commit only when gates are green; keep changes scoped to the current phase.
- **Schema up front, repositories on demand.** Each phase migrates the **full schema it
  introduces** up front (the schema is the source of truth; Drizzle handles the churn), but
  build data-access **repositories only for the tables that phase actually uses**. Phase 0
  migrates the entire §10 schema and implements repositories for `projects` and `providers` only.

## Stack (per DECISIONS.md)

- **Language:** TypeScript (strict), end to end. No `any` without justification.
- **Daemon:** Node ≥ 20, Fastify + `ws`, `execa` (subprocess), `simple-git` + raw `git worktree`.
- **Persistence:** SQLite via `better-sqlite3`; schema and migrations with `drizzle-orm`.
- **Web:** React + Vite + Tailwind, Zustand (UI state), TanStack Query (server state), native WebSocket.
- **CLI:** `commander` + `@clack/prompts`. Distributed as a global npm package with a `thaloslab` bin.
- **Shared types** (`Ticket`, `AgentConfig`, `WorkflowTemplate`, `OrchestratorMessage`, WS events)
  are defined once in `packages/shared` and imported by both daemon and web — never duplicated.
  `shared` is **compiled to `dist/` and consumed compiled** (not inlined from `.ts` source); its
  relative imports use explicit `.js` extensions. It must be built before daemon/web/cli — `pnpm
  build` and `pnpm dev` build (and `dev` watches) it first. See DECISIONS #21.

## Execution modes (DECISIONS §3)

- default = **preview** — real planning, no code mutation, nothing written to the repo.
- `--live` — real provider invocation, real shell execution, real diffs and merges.
- `--mock` — dev-only, fully stubbed providers, zero token spend, for testing the engine.

## Layout

```
thalos-lab/
  packages/
    cli/        # thaloslab bin: menu, flags, daemon launcher
    shared/     # shared TS types (imported by daemon + web)
    daemon/     # server, orchestrator, workflow engine, providers, git, store, collab
    web/        # React UI
  docs/
    SPEC.md
    DECISIONS.md
  CLAUDE.md     # this file — repo root
```

## Gate toolchain

- **test:** Vitest · **lint:** ESLint + `@typescript-eslint` · **typecheck:** `tsc --noEmit` ·
  **format:** Prettier.
- **Bundling:** the publishable `cli` and `daemon` packages are bundled with **tsup** (esbuild);
  **web** is built by **Vite**.
- **Aggregate gate:** a single root `gate` script runs typecheck + lint + test. This is the
  definition of "green" — the bar every phase must clear before a task is called done.
- Wire the aggregate gate as a **pre-commit hook** (e.g. Husky + lint-staged, or a simple
  `.husky/pre-commit` calling `pnpm gate`) so "show passing gate output before done" is enforced
  mechanically, not by memory.

## Commands

Concrete pnpm invocations (root scripts; keep current as the toolchain evolves):

- build: `pnpm build` (ordered: shared → web → daemon → cli; tsup bundles cli/daemon, Vite builds web, web SPA copied into the daemon bundle)
- typecheck: `pnpm -r typecheck` (`tsc --noEmit` per package)
- lint: `pnpm -r lint` (ESLint + `@typescript-eslint`)
- test: `pnpm -r test` (Vitest)
- format: `pnpm format` (Prettier)
- **gate (aggregate, run before done):** `pnpm gate` → typecheck + lint + test
- dev: `pnpm dev` (daemon watch + Vite dev server)
