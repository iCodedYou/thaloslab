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
| 22 | Worktree topology — the lane model | one branch + worktree + gate-state per **lane**; sequential stages share a lane, fan-out engineers get isolated lanes; integration merges into `thalos/integration` only, never the default branch |
| 23 | Merge-conflict posture | bounded, merge-scoped auto-resolve + full-gate re-check before accept; blast-radius changes escalate **immediately** (no agent touches sensitive merge markers) |
| 24 | Specialist-gate realness — no silent no-op | every declared blocking gate either runs a real check or converts to a blocking **human** gate; a gate may never report green having run nothing |
| 25 | Neutral permission policy | the engine speaks a vendor-neutral `ToolPolicy`; each adapter's `enforce(policy)→{args,unmet}` translates it, declaring what it CANNOT express — `unmet` is the router's fail-closed filter |
| 26 | Constraint-aware cross-provider routing | the router picks the provider (engine never does), FAIL-CLOSED: only providers that can enforce the role's policy are eligible; reviewer MUST differ from the engineer's provider, auditor PREFERs; nothing eligible → PARK/escalate, never run unconstrained |
| 27 | Greenfield bootstrapping + phase transition | a scratch project's first ticket runs the greenfield workflow (phase-driven); the baseline is BORN by the scaffold; `done` flips bootstrapping→maintenance; the MVP NEVER auto-lands on `main` (no exception); integration-sweep (full acceptance suite) is the "MVP exists" gate |
| 28 | OS sandbox — self-test is the pre-trust gate | the sandbox is the 4th, OUTERMOST defense-in-depth layer (makes pathScope + network:none REAL); "verified" = a real escape probe was DENIED, never "binary present"; local = sandbox-when-available (DiD floor), collab = sandbox-REQUIRED (fail-closed); a verified jail relaxes the per-command-allowlist unmet (never network-allowlist) — relaxation per-invocation only, sharing one flag with the spawn so "relaxed-but-not-wrapped" is impossible |
| 29 | Collab trust — three-legged threat model | (1) the executor's sandbox protects it FROM the task (sandbox-required); (2) the host's gates + host-git changedFiles + quarantine + reviewer-differs-by-VENDOR protect the codebase FROM untrusted peer output; (3) data confidentiality is ONE-WAY/no-claw-back — minimize (allowlist pack, secret-strip-that-aborts) + inform (host-visible manifest); creds never cross; token + EXPLICIT human admit + revoke |

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

### 22. Worktree topology — **the lane model** (resolved during Phase 2)

Isolation is expressed by a **lane**: one git branch + one worktree + one gate-state file, identified by a `laneId` on each task. This makes both topologies fall out of *who shares a laneId*, instead of one assumption overwriting the other:

- **Sequential stages share a lane** (`<ticketId>:main`) — e.g. the bug-fix's repro→fix→review run in one worktree so the reproduction test reaches the engineer.
- **Parallel fan-out children get isolated lanes** (`<ticketId>:seam-<i>`) — each engineer builds in its own worktree off `thalos/integration`, on a clean module/service seam the architect declared. The seam is **path ownership** (`task.seamPaths`), enforced by the post-run audit (a write outside the seam fails the run).

Lane branches are created **idempotently** (adopt-or-create) so a crash that loses the in-memory worktree cache but leaves the lane on disk recovers cleanly. A builder's work is **committed to its lane branch** after its gates pass; the integrator merges every lane branch that is *ahead of integration* (covering both topologies) into `thalos/integration` — **never** the repo's default branch. Landing on the default branch remains a separate, explicit human action.

*Refines SPEC §9.*

### 23. Merge-conflict posture — **bounded auto-resolve, blast-radius escalates immediately** (resolved during Phase 2)

The integrator merges lane branches one at a time, deterministically. On a real `git` conflict:

- if the change's **blast radius is non-empty** (auth / payments / data / infra) → **escalate immediately**; no agent touches sensitive merge markers.
- otherwise → a **bounded** (≤2), **merge-scoped** resolver agent edits *only* the conflict markers (it may not rewrite logic to force a green build), and the **full gate suite must pass** before the merge is accepted. Exhausting the bound, or a red re-gate, aborts the merge (leaving integration clean) and escalates with the conflicted files.

After all lanes merge cleanly, the **full suite runs once more** against the pre-integration baseline — the "works-alone, breaks-together" backstop that catches a semantically broken combination the per-merge gate can't see.

*Refines SPEC §7 / §9.*

### 24. Specialist-gate realness — **no silent no-op** (resolved during Phase 2)

A declared blocking gate may **never** report green having run nothing. Specialist gates run honest checks — security (secret + dangerous-pattern scan + dependency audit), benchmark (real baseline-vs-after measurement), a11y (rule-based HTML inspection). A gate check with **no automated implementation** (e.g. visual-diff) is **converted at assembly into a blocking human gate** that parks the ticket for manual review; the runner also blocks loudly as defense in depth. The roster + gate-config are **assembled from triage data** (blast radius → security auditor + mandatory security gate + human deploy gate), not hardcoded per template.

*Refines SPEC §7.*

### 25. Neutral permission policy — **`ToolPolicy` + `enforce()`** (resolved during Phase 3)

The engine speaks a **vendor-neutral** `ToolPolicy` (canRead/Write/ExecCommands, command allow/deny
patterns, network posture, path scope, `relaxable`). Each adapter implements
`enforce(policy) → { args, unmet }` — pure, zero-cost — translating the policy into that CLI's own
mechanism and **declaring the constraints it CANNOT express** (`unmet`). No constraint may silently
map to "unenforced": `unmet` is the router's fail-closed filter. Claude (per-tool allowlist) can
express everything → `unmet` always empty; Codex/Gemini (coarse sandbox + approval) cannot express a
per-command allowlist → builders fail-closed onto Claude, while the read-only review/audit roles map
everywhere. The previous Claude-flavored `allowedTools` strings were a vendor leak in a
supposedly-neutral contract; this removes it. *Refines SPEC §5.*

### 26. Constraint-aware cross-provider routing — **fail-closed** (resolved during Phase 3)

The **router** picks the provider; the engine never does (single chokepoint, like privilege). Pure
function of (availability, per-project preference order [default = detection order claude>codex>gemini,
overridable via `Project.routingPolicy`], the providers' `enforce→unmet`, the role's differ-rule).
Order: installed+authenticated → **filter to providers that can enforce the role's policy** →
preference order → differ-rule. The **reviewer MUST differ** from the engineer's ACTUAL provider, the
**security-auditor PREFERs** to; degrade to same-provider-fresh-context when only the avoided is
capable; **nothing eligible → PARK a human gate / escalate** naming the unmet constraint + provider —
never run unconstrained. Provider assignment is split: a preferred provider is baked at assembly
(visible in the Agents tab), re-resolved at invoke against live availability + the engineer's
recorded `run.provider`. *Refines SPEC §5.*

### 27. Greenfield bootstrapping + Bootstrapping→Maintenance transition (resolved during Phase 4)

A from-scratch project starts as a README commit on `main` with `.thalos/` scaffolded (the git
substrate); `phase` becomes load-bearing. **Intake routes by phase, not triage:** a `bootstrapping`
project with no *completed* greenfield ticket gets the **greenfield workflow** (spec → spec-signoff →
scaffold → scaffold-integrate → decompose fan-out → impl lanes → integrate → security → pre-ship); a
concurrent second bootstrap is rejected. The **architect INVENTS** the module structure (the scaffold
materializes it as real dirs + interface-contract stubs, so the existing disjointness/path-ownership
guards work on designed seams exactly as on discovered ones).

**The gate model inverts gracefully — no "weaker gates for greenfield."** Greenfield names no
`repro`/`fix` stage, so the differential machinery is simply never selected; gating is **absolute**.
The decisive fix: `detectGateCommands` reads the **stage's worktree** (`wt.path` / `integDir`), not
the main repo — the scaffold's `package.json` lives on `thalos/integration` before it ever reaches
`main`, and reading `main` would return `{}` and let every gate **silently pass having run nothing**.
The **baseline is BORN** by the scaffold commit and grows as seams land; once the ticket is `done`,
the suite IS the baseline and ticket #2 (maintenance) gets the Phase 1-3 differential machinery back.

**Acceptance teeth live at integration-sweep.** Because the whole-MVP acceptance suite is RED until
every seam lands, `impl-green` is **compile-level** (build/typecheck/lint — the lane builds against
the contracts) and the **full acceptance suite runs once, on the combined tree, at integration-sweep**
— the single gate that proves "the spec's acceptance criteria are met = MVP exists." A seam left
unimplemented stays red there → no `done` → no flip.

**The transition:** `setProjectPhase` flips bootstrapping→maintenance in `reconcileTicket` ONLY on
terminal `done` (unreachable from the escalate/fail branches), guarded by phase (idempotent under
reconcile's repeats + terminal-absorb); DB authoritative, `.thalos/config.json` a best-effort mirror.
**No landing exception:** the workflow ends on `thalos/integration`; the MVP→`main` land stays a
separate human-authorized action (the highest-stakes land — last to automate), uniform across all
tickets. *Refines SPEC §6 + §7.*

### 28. OS sandbox — the deferred least-privilege backstop; self-test is the pre-trust gate (Phase 5)

The sandbox is the **4th, OUTERMOST** layer of the SPEC §9 defense-in-depth (it composes with — does
not replace — the path-audit, provider flags, denylist). It is the only layer that makes `pathScope`
and `network:none` **OS-REAL** rather than advisory (today a subprocess inherits full network and can
`curl`, and the path "scope" is a post-hoc `git status`). All FOUR spawn sites route through one
`spawnSandboxed` chokepoint — the 3 adapters AND the gate runner (`pnpm test` runs arbitrary repo
code; unwrapped it is the jail's escape hatch).

- **"Verified" = a real escape was PROVEN blocked**, never "the binary is present." The self-test runs
  a probe under a denying scope and is `ok` ONLY if the probe was denied — fs by **host-readback** (did
  the probe's write reach a HOST file? — correct for both namespace jails *and* containers, whose fs is
  writable-but-host-isolated), net by the probe's reachability. A present-but-misconfigured jail fails
  its self-test and is treated EXACTLY like `NoopSandbox` (not trusted). Cached by `(id, version, os)`.
- **Posture:** local = **sandbox-when-available** (the existing layers are the documented floor —
  single-user v1 doesn't require OS containment; `--require-sandbox` opts in); collab = **sandbox-
  REQUIRED, fail-closed**. **Containment (wrap this run?) and relaxation (drop an unmet?) are SEPARATE:**
  relaxation is strict EVERYWHERE.
- **Router interaction (the un-pin):** a verified `fs-scope`+`network-none` jail makes the per-command
  allowlist's *purpose* (blast-radius containment) moot at the OS level → its `unmet` is dropped → a
  Codex/Gemini builder becomes capable. This is NOT "the CLI now expresses the allowlist." **Hard
  asymmetry: `network-allowlist` is NEVER jail-satisfiable** (no per-domain filtering) — only
  `network:none` is, so a `network:allowlist` policy stays pinned even sandboxed (the proxy is
  DEFERRED). The relaxation and the spawn share ONE `requiredByRouter` flag, so "relaxed-but-not-
  wrapped" is structurally impossible. *Refines SPEC §5 + §9 + §14.*

### 29. Collab — the three-legged threat model (Phase 5)

Pooling moves the trust boundary off the machine. The spine has THREE legs — the third is categorically
different (no after-the-fact backstop):

1. **Execution containment** — the EXECUTOR's sandbox protects it FROM the task. A peer runs every
   pooled invocation in ITS OWN verified jail and re-enforces the `ToolPolicy` on its side; a peer with
   no verified sandbox is **unroutable** (this is *why* the sandbox is the prerequisite). Reversible: n/a.
2. **Output integrity** — the HOST's gates protect the codebase FROM untrusted peer output. The peer
   returns a patch (DATA, never an effect); the host applies it in a **quarantine** worktree, derives
   `changedFiles` from its OWN git (never the peer's self-report), re-runs ALL gates, runs the seam
   audit, and applies **reviewer-differs by VENDOR** (a `collab:peer:codex` is not a valid differ for a
   local `codex` engineer). Reversible: yes — re-checked after.
3. **Data confidentiality** — **ONE-WAY, no claw-back.** Once the context pack crosses, a consented peer
   can read it; nothing re-checks what already left. The only lever is **MINIMIZE** (allowlist-first
   pack, never whole-repo; a secret deny-net + a content scan that ABORTS the build, never warns) +
   **INFORM** (a host-visible manifest — path+sha256 of exactly what crossed). **The residual is
   ACCEPTED, not mitigated:** a consented peer reads the pack; that is the cost of pooling, made minimal
   and informed, not reversible.

Transport: a SEPARATE authenticated endpoint (not the zero-auth localhost ws), bound to LAN/tunnel ONLY
while active+consented; **one-time token + EXPLICIT human admit** (a valid token alone never authorizes)
+ revoke; creds NEVER cross — the invoke carries the neutral `ToolPolicy` + a context ref, never API
keys. *Refines SPEC §11 + §14.*

### 30. Tauri desktop shell + observability — wrap, don't widen (Phase 6)

Phase 6 is packaging + instrumentation over the complete engine; the bar is **add no trust surface**.

**Desktop shell — a thin window that navigates to the daemon, never re-exposes it.** The shell loads
`http://127.0.0.1:8473` (the daemon-served SPA) in a webview — the **same origin** as `/api` + `/ws`,
so the daemon needs **no CORS** and its "no external origin is ever admitted" posture holds *by
construction*. The alternative — bundling the SPA as `tauri://` assets — is **rejected**: it makes
every `/api` call cross-origin and forces `@fastify/cors` onto the zero-auth localhost server (a new
externally-shaped surface). The daemon is started by **exec-ing the proven `thaloslab --no-open`
launcher** (the reuse-or-spawn lifecycle stays in the CLI; the shell replicates **zero** lifecycle
logic — the "second daemon" bug lives only in a reimplementation, and the daemon's PID-idempotency
backstop is the final guard). The bind host is never passed from the shell — it stays hardcoded
`127.0.0.1`; a LAN/`0.0.0.0` bind remains a code + collab-admit security change, never a packaging
default. The config is locked down (`withGlobalTauri:false`, `dangerousRemoteDomainIpcAccess:[]`, CSP
`connect-src` loopback-only, asset protocol off, `shell` capability scoped to the one sidecar binary,
no `shell:allow-open`) and **mechanically asserted by a config-lint test that parses the actual JSON**.
The collab explicit-admit step is unchanged (the Collab tab calls the same admit endpoint). The native
`tauri build` is **DEFERRED-PENDING-TOOLCHAIN** (no Rust on the build box) — two claims kept distinct:
the config + lint prove the trust-**preservation intent**; only a real build + runtime smoke on a Rust
box proves the **packaged app behaves**.

**Observability — metadata only, read-and-aggregate, no new sink.** A read-only telemetry API
(`GET /api/observability/:projectId`, `/api/tickets/:id/telemetry`) + an Insights tab surface token/
cost/timing/run-status/escalation rollups per provider and per collab peer. It adds **no new persisted
data**, so it cannot become a new exfiltration surface. Two safe-access rules, enforced structurally:
`runs` is read via a hand-written safe-column projection (never `toRun()`/`SELECT *`, which carry
`prompt`+`output`); `task_events` is **count-by-type only** (its `payloadJson` holds the raw
`agent.output` stdout chunk — a second secret-bearing vector — so it is never projected). The leak test
plants secrets in **both** vectors and proves they are absent from every endpoint **and** from the repo
projection itself (so a leaky `SELECT` fails even though the numeric rollup would otherwise aggregate it
away). *Refines SPEC §4 / §13 / §15.*

---

## Deferred / open items (named, not silently skipped)

**The complete list (one place; each runs for real on-target before it is trusted):**

| Tag | What | Pre-trust gate that runs before it's trusted |
|---|---|---|
| ✅ `VERIFIED-ON-INSTALL` (2026-06-30, **mostly**) | Codex/Gemini real `enforce()` mapping + stream-parser conformance (Phase 3) | DONE for the safety-critical core, against codex-cli **0.142.2** + gemini **0.49.0**: both `enforce()` mappings checked vs real `--help` + reality tests; reconstructed mistakes FOUND + FIXED — codex `--ask-for-approval` (rejected by exec) removed; codex network:none made EXPLICIT (`-c sandbox_workspace_write.network_access=false`) instead of a user-overridable default (too-loose); gemini `--exclude-tools` (DOES NOT EXIST — exit 1) replaced with `--approval-mode plan`/`yolo` + `--skip-trust`; gemini `network-none` now UNMET for builders (too-loose — web tools weren't actually disablable); gemini `--output-format stream-json` adopted. Codex parser VERIFIED vs a real capture. The cross-vendor ROUTING is verified deterministically (`cross-provider.test.ts`). **STILL DEFERRED (4 sub-items):** (a) `codex-on-PATH` — codex installs OFF-PATH (`~/AppData/Local/OpenAI/Codex/bin/<hash>`) so `whichSync` can't detect it; (b) `gemini-stream-recapture` — the assistant/result stream event is INFERRED (gemini API 503s blocked a clean capture); (c) gemini per-command allowlist via the Policy Engine (`--policy`) — kept UNMET/strict, not built; (d) `live-xvendor-handoff` — a real claude-builds→codex-reviews `--live` run was NOT reached (the bug-fix `repro`/test-author stage doom-loops under live ×3 before the reviewer; the feature workflow has no reviewer) |
| ✅ `VERIFIED-BUDGET` (2026-06-30) | the `--live` greenfield smoke (Phase 4) — **RAN, one real spec** | DONE: a capped `--live` run (real Claude, `scripts/smoke-greenfield.ts`) on a small spec (`wc-lite`, a minimal `wc`) reached `done` in **5 invokes / 81.4k tokens / 2.6 min / 2 lanes** — well under every cap (12/300k/15min/2). The architect invented structure and decomposed into **2 genuinely PATH-disjoint lanes** (`src/count.js` vs `bin/wc-lite.js`+`package.json`) that ran as parallel seam worktrees — NOT collapsed to one. The MVP is BUILDABLE: `printf 'hello world\n' \| node bin/wc-lite.js` → `1 2 12` (acceptance met); `main` was never touched; integration-sweep gated `done`. Nuance (real-world messiness, MVP still correct): the CLI lane **inlined** its own counting logic instead of importing the lane-0 contract, and the scaffold left orphan stubs (`count.js`/`cli.js`) — so path-disjoint held, but logic-DRY did not. **One run, not a guarantee every greenfield holds.** |
| ✅ `VERIFIED-ON-LINUX` (2026-06-30) | real bubblewrap confinement (Phase 5) — **VERIFIED** | DONE: the real self-test's escape probe was genuinely DENIED on kernel `6.18.33.2-microsoft-standard-WSL2` + bubblewrap 0.11.1 — fs by host-readback, net by `ENETUNREACH` under `--unshare-net` ⇒ `selfTest().ok=true`; the router relaxation then un-pinned a Codex builder, while Noop re-pinned to Claude. See "Phase 5 sandbox — VERIFIED-ON-LINUX" below |
| ✅ `VERIFIED-ON-MACOS` (2026-06-30) | native macOS **sandbox-exec (Seatbelt)** confinement (Phase 5) — **VERIFIED** | DONE on **macOS 26.3 (build 25D125) / arm64 (Apple M4 Pro)**: the real self-test's escape probe was genuinely DENIED on both axes — fs by host-readback (a write to a HOST path OUTSIDE the rw set returned `EPERM` and never reached the host file), net by `EPERM` at the socket under `(deny network*)` — ⇒ `selfTest().ok=true`; a hollow/toothless `(allow default)` profile still ESCAPES ⇒ `ok=false` (the verifier does not rubber-stamp the binary's presence). The Linux-shaped net-blocked errno set was extended (DARWIN-GUARDED) to recognize Seatbelt's `EPERM`/`EACCES` syscall denial — same defect class as the Linux loopback-probe bug, fixed the same way. Exact invocation: `sandbox-exec -p '<SBPL profile>' <cmd> <args>`. Guarded test `sandbox-exec.test.ts` (`describe.runIf(darwin)`) re-runs it; skips off-macOS. See "Phase 5 sandbox — VERIFIED-ON-MACOS" below |
| ✅ `collab peer-agent entrypoint` (2026-06-30) | a runnable peer-agent PROCESS (Phase 5, **F1**) | DONE: `thaloslab peer` boots a standalone **DB-less** peer-agent (separate tsup bundle — no better-sqlite3/Fastify in its closure, grep-proven), self-tests its OWN sandbox honestly, dials host URL+token, parks/serves. Axis 1 proven through the **REAL bin** on Windows (honest Noop self-test → refused at join, exit 3) + mutation proof (flip ONLY the verdict → admittable) — the refusal is verdict-driven, not hardcoded |
| ✅ `VERIFIED-OVER-TAILSCALE` (2026-07-01) | cross-machine collab **WIRE + verified-peer-JOIN + explicit-ADMIT** over a real network (Phase 5, **F0–F3**) | DONE on real hardware, **two OSes / two verified sandboxes**: Windows HOST (`100.82.212.113`) + cofounder's **macOS** PEER (sandbox-exec, `ok=true`) over **Tailscale**. Fail-closed off-loopback bind proven LIVE — bound to `100.82.212.113` ONLY (`netstat` shows the tailnet IP, not `0.0.0.0`; `127.0.0.1:8474` refused). The Mac dialed across the tailnet, self-tested VERIFIED, **parked on the token** (`routable=false`), and became `routable` ONLY on the host's **explicit admit**; `disable` closed the off-loopback listener (port refused after). Consent line RECORDED in `daemon.log` (fixed: was `console.warn`, silently discarded under the daemon's `stdio:'ignore'` — a consent line nobody can see is no consent line). **Kept DISTINCT:** proven = wire + trust state machine + admission across machines; NOT proven = a real task actually dispatched down the wire (the `--mock` round-trip through the daemon needs the DISPATCH seam next) |
| ✅ `collab engine→dispatch MECHANISM` (2026-07-01, **built + mutation-proven**) | the daemon's engine dispatching a task to a routable collab peer. **DONE + gate-green:** G0 `c46d93c` (`collab-route.ts` `resolveCollabRoute`) — a fail-closed gate: dispatch ONLY when the project opted in (`routingPolicy.collab`) AND the task names a routable `collab:<peer>:<vendor>` AND differ-by-vendor holds; else PARK; `'auto'` NEVER collab (mutation-proven: bypass the gates → 3 park tests red). G1 `61c1514` — the StageRunner builds `makeCollabAdapter` INLINE over the live PeerLink, dispatches via `executeRun` wrapped in try/catch → fail-closed on `PeerRevokedError`/`SecretLeakError`/`PeerInvokeTimeoutError` (mutation-proven: re-throw → the throw-tests raw-throw out of `run()` instead of escalating; a revoked peer's patch never reaches quarantine). The FULL round-trip — pack→push→quarantine→host-git re-derive→re-gate + manifest + lying-peer-caught — runs through the REAL `StageRunner.run` over a real socket, `--mock`; Wire D unchanged. **The MECHANISM is proven; running it from a REAL ticket needs the CONFIG SURFACE below.** | mechanism proven in-process/loopback; the live cross-machine round-trip needs the config surface (next) + a second machine |
| `DEFERRED` (collab — dispatch CONFIG SURFACE) | **the last seam** (found during G2, 2026-07-01): NOTHING makes a real production ticket TARGET a peer. (a) Assembly's `assignProvider` resolves only LOCAL providers (`routerCtx.availability = listProviders()` — collab peers are never in it), so an engineer agent is never `collab:<peer>:<vendor>`; (b) `POST /api/projects` doesn't accept `routingPolicy` and there is no `updateProject`, so `routingPolicy.collab` (the G0 gate's requirement) can't be set via API; (c) the feature template's engineers are fan-out children created AFTER the plan gate, so injecting a target into a real ticket is racy. The dispatch MECHANISM is built + proven (row above) — this is the CONFIG surface that POINTS a ticket at a peer, kept DISTINCT from it. **NOT hacked live:** a hand-forced config would prove nothing G1 didn't already prove deterministically, while the actual gap stayed unbuilt | build collab-aware assembly + a `routingPolicy.collab` API/UI + a way to set a task's agent target to `collab:<peer>:<vendor>` (its own plan + review + green gate); THEN one ~15-min live `--mock` round-trip through the real daemon to the Mac peer (needs the second machine) closes G2 |
| `DEFERRED` (collab — jail-over-wire) | a peer GENUINELY jailing the host's task *over the wire* (Phase 5). EVERY round-trip so far — Wire D, G1, and the coming G2 — runs the peer in `--mock`, which writes files DIRECTLY and bypasses `spawnSandboxed`; so the peer's jail confines its SELF-TEST (the admission gate, VERIFIED-ON-MACOS/LINUX), NOT the task. **G2 does NOT clear this** — dispatch-across-machines ≠ task-confined-by-the-peer's-jail | run the peer-agent on a box with a VERIFIED jail (bubblewrap / sandbox-exec — the entrypoint EXISTS) executing a REAL (non-mock) task arriving over the socket, and prove the jail confined it |
| `DEFERRED` (collab — real-provider) | a REAL provider (Claude/Codex/Gemini) executing a peer's task over the wire with real tokens (Phase 5). The wire tests + the G2 live round-trip run the peer in `--mock` (deterministic, zero cost). **G2 does NOT clear this** — dispatch-under-`--mock` ≠ a real provider ran the task | a capped `--live` collab smoke: a real CLI runs a peer's task end to end over the socket |
| `DEFERRED-PENDING-TOOLCHAIN` | the native Tauri `tauri build` + packaged-app runtime smoke (Phase 6) | on a Rust box: build the shell, confirm the window truly loads `127.0.0.1:8473`, the CSP is enforced by the webview, and the sidecar truly reuses the daemon (the config-lint proves the locked-down intent, not the running app) |
| `DEFERRED` (no target) | the per-domain network-allowlist filtering proxy (Phase 5) | n/a — only `network:none` is jail-enforceable, so `network:allowlist` stays Claude-pinned |

Until each is run-and-passed on real hardware, its subject stays at the safe posture already in place
(an unverified jail = NoopSandbox-equivalent → no router relaxation, collab fail-closed; an unverified
provider mapping = the mock's assumption, not a proof). Nothing below is overclaimed. **Two items have now
cleared their gate: `DEFERRED-PENDING-LINUX` → `VERIFIED-ON-LINUX` and `DEFERRED-PENDING-MACOS` →
`VERIFIED-ON-MACOS` (both 2026-06-30)** — the real bubblewrap jail confined on a real kernel, and the
real sandbox-exec jail confined on real macOS hardware (details below). **A third has now cleared its gate:
`DEFERRED-PENDING-MULTI-MACHINE` (the cross-machine wire + verified-peer-join + admit) → `VERIFIED-OVER-TAILSCALE`
(2026-07-01)** — a real macOS peer joined a Windows host over Tailscale, and the peer-agent entrypoint that
the macOS verification named as missing now EXISTS (F1). What remains, newly named and kept DISTINCT, is the
**engine→collab DISPATCH** — the last unwired seam: admitting a peer makes him routable, but no daemon code
yet routes a task down the wire to him (its own plan + review + green gate, given it is the most
security-sensitive path in the system).

**Verification surfaced (and fixed) one real defect, the kind only a real kernel reveals:** the net
self-test originally probed `127.0.0.1` — but every network namespace has its OWN loopback (present even
under `--unshare-net`), so a loopback probe could not distinguish an isolated namespace from the host
(it returned `ECONNREFUSED` either way ⇒ false `connectedOut`). Direct diagnosis confirmed the jail
*does* isolate (external `1.1.1.1:53` → `CONNECTED` with net inherited, → `ENETUNREACH` under
`--unshare-net`); the probe was just measuring the wrong address. Fix (design-preserving, same two-axis
verdict): probe TEST-NET-1 `192.0.2.1` (RFC 5737 — no real host is contacted) and treat only no-route
codes (`ENETUNREACH`/`EHOSTUNREACH`/`ENETDOWN`/`EADDRNOTAVAIL`) as blocked; everything else (incl.
timeout/unknown) is reachable → fail-closed. Re-run ⇒ `ok=true`.

### Phase 5 — sandbox + collab (the value of this phase is that its gaps are NAMED — and now closing)

The trust LOGIC is proven on the Windows build machine (self-test decision logic, router relaxation,
the three collab axes via an in-process mock peer). The Linux jail's **REAL confinement is now VERIFIED**
(2026-06-30, above); **macOS confinement is now also VERIFIED** (2026-06-30, sandbox-exec on macOS 26.3 /
arm64 — below). The REAL cross-machine wire (and a peer genuinely jailing over it) remain deferred behind
self-tests/mocks that run **for real on-target before trust** — exactly like Phase 3's
deferred-pending-install. A reader must not mistake a *deferred* jail for a verified one — and neither the
Linux nor the macOS jail is deferred any longer (the cross-machine wire still is).

**Cross-platform sandbox — what is verified vs deferred:**

| OS | Backend | Verified on hardware? | Status |
|---|---|---|---|
| Linux | bubblewrap (rootless userns) — **implemented** | **YES** — kernel 6.18.x WSL2 + bwrap 0.11.1 (2026-06-30) | ✅ **VERIFIED-ON-LINUX** |
| macOS | sandbox-exec (Seatbelt) — **implemented** | **YES** — macOS 26.3 / arm64 (Apple M4 Pro) (2026-06-30) | ✅ **VERIFIED-ON-MACOS** |
| Windows (build box) | WSL2 / Docker — neither present → **NoopSandbox** | n/a (no real jail) | local unsandboxed (DiD floor), collab fail-closed |

- **VERIFIED-ON-LINUX (2026-06-30):** the real bubblewrap jail's confinement was proven on a real Linux
  kernel (WSL2 6.18.x, bubblewrap 0.11.1, unprivileged userns available — `bwrap --ro-bind / / --unshare-all
  true` → exit 0). The real self-test genuinely DENIED both escapes — fs by host-readback (the probe's
  token never reached the host file), net by `ENETUNREACH` under `--unshare-net` — ⇒ `selfTest().ok=true`,
  and the router relaxation then un-pinned a Codex builder (Noop re-pinned to Claude). A permanent guarded
  test (`backends.test.ts`, `describe.runIf(linux+bwrap)`) re-runs this on any Linux box; it skips off-Linux
  so the Windows gate is unaffected. The exact jail flags: `bwrap --die-with-parent --new-session --unshare-{user,pid,ipc,uts}
  --ro-bind / / --tmpfs /tmp --proc /proc --dev /dev --bind <rw> <rw> --unshare-net`.
- **VERIFIED-ON-MACOS (2026-06-30):** the native macOS sandbox-exec (Seatbelt) jail's confinement was proven
  on real hardware — **macOS 26.3 (build 25D125), arm64 (Apple M4 Pro)**. The backend compiles a SBPL
  profile (`(allow default)` with two teeth: `(deny file-write*)` re-allowing only the rw subpaths + the
  /dev nodes, and `(deny network*)` for `network:none`) and runs `sandbox-exec -p '<profile>' <cmd> <args>`.
  The real self-test genuinely DENIED both escapes — fs by host-readback (the probe's write to a HOST path
  outside the rw set returned `EPERM` and never reached the host file: `selfWrote:false`), net by `EPERM`
  at the socket under `(deny network*)` (`connectedOut:false`) — ⇒ `selfTest().ok=true, fsBlocked, netBlocked`.
  The verifier still FAILS on a non-confining jail: a hollow `(allow default)` profile lets the probe escape
  (`selfWrote:true, connectedOut:true`) ⇒ `ok=false`. The self-test's net-blocked errno set was Linux-shaped
  (no-route codes only); Seatbelt denies at the `socket()` syscall with `EPERM`/`EACCES`, so those are now
  recognized DARWIN-ONLY (`netBlockedCodes('darwin')` ⊋ `netBlockedCodes('linux')`; the Linux set is
  unchanged, so VERIFIED-ON-LINUX is preserved) — the same defect class as the Linux loopback-probe bug. A
  permanent guarded test (`sandbox-exec.test.ts`, `describe.runIf(darwin)`) re-runs the real + hollow cases
  on any macOS box; it skips off-macOS so the Linux/Windows gate is unaffected. **What this does NOT prove:**
  the collab round-trip over the wire FROM this Mac — the peer-agent entrypoint now EXISTS (F1) and a macOS
  peer has JOINED a host over Tailscale (VERIFIED-OVER-TAILSCALE, 2026-07-01), but a real task DISPATCHED to
  it (engine→dispatch deferral) and a macOS peer genuinely jailing that task over the wire (jail-over-wire
  deferral) both remain.
- **✅ VERIFIED-OVER-TAILSCALE (2026-07-01, cross-HOST wire + join + admit):** the WIRE is now PROVEN
  cross-machine — a real **macOS** peer dialed a **Windows** host (`100.82.212.113`) over **Tailscale** and
  completed the join handshake + explicit admit on real hardware. The **fail-closed off-loopback bind**
  behaved exactly as F2's mutation-proven tests promised: bound to the Tailscale interface ONLY (`netstat`
  showed `100.82.212.113:8474`, not `0.0.0.0`; `127.0.0.1:8474` refused), consent RECORDED in `daemon.log`,
  and `disable` closed the listener (port refused after). The peer self-tested VERIFIED (`sandbox.ok=true`,
  his real sandbox-exec jail), **parked on the token** (`routable=false`), and became routable ONLY on the
  host's explicit admit — the token-alone-never-authorizes gate held across two machines. Sub-phases
  F0 (routes drive the socket) / F1 (peer-agent entrypoint, DB-less) / F2 (off-loopback bind) are committed
  + gate-green. **KEPT DISTINCT — what is NOT proven:** a real task actually DISPATCHED down the wire. The
  round-trip machinery (pack → push → quarantine → host-git re-derive → re-gate → manifest) is proven over a
  real socket in Wire D, but has **zero production callers** — the daemon's engine has no collab dispatch
  path (the `engine→dispatch` deferral above). So the live milestone is *wire + trust + admission across
  machines*, NOT *a task run on the peer through the daemon*.
- **Still DEFERRED (cross-HOST, must NOT be read into the above):** the **engine→collab dispatch** seam (the
  last unwired path — its own plan + review + green gate, as the most security-sensitive route in the
  system); a peer GENUINELY jailing a real task over the wire (Wire D used a test SEAM, not a real jail —
  the entrypoint now exists, so this is runnable next); a REAL provider executing a peer's task with real
  tokens (the wire tests + the first live round-trip use `--mock`); and NAT/tunnel/latency beyond Tailscale.
- **DEFERRED (no target needed):** the per-domain network-allowlist filtering proxy — `network:none` is
  the only jail-enforceable posture, so a `network:allowlist` policy stays Claude-pinned even sandboxed.

**DEFERRED-PENDING-BUDGET (Phase 4 — the `--live` greenfield smoke).** Greenfield is the largest
single token spend in the project (a full MVP from nothing). The deterministic `--mock` bar is the
**standing proof** (the full run → done → flip, the *born baseline* via ticket #2, the
integration-sweep *teeth*, the absorbing partial-failure path). The **real `--live` greenfield smoke**
— a manual, opt-in, never-in-CI build of a deliberately tiny MVP that exercises discovery →
spec-gate → architect-invents-structure → multi-lane build on real `pnpm` — ran under a hard cap
decided in advance: **≤ 2 seams/lanes, ≤ 300k output tokens (≈ $5), ≤ 15 min, ≤ 12 agent invocations**;
**first cap hit ABORTS** (`scripts/smoke-greenfield.ts`, a verification harness — the greenfield engine
is untouched).

**✅ VERIFIED-BUDGET (2026-06-30).** One capped `--live` run on a small spec (`wc-lite`) reached `done`
in **5 invokes / 81.4k tokens / 2.6 min / 2 lanes** — comfortably inside every cap (the caps were
generous for a small greenfield, not tight). What it taught (the point of the run): (1) the architect
produced a **BUILDABLE** MVP — `printf 'hello world\n' | node bin/wc-lite.js` → `1 2 12`, acceptance met,
`main` untouched; (2) it decomposed into **2 genuinely PATH-disjoint lanes** that ran as parallel seam
worktrees — it did NOT collapse to one (the Phase 2 question gets a *positive* answer for path-disjointness
on an invented structure); (3) **integration-sweep behaved as the MVP-exists gate** — `done` requires it
green, and the real acceptance passing confirms it gated under real tokens; (4) **real-world messiness, MVP
still correct**: the CLI lane inlined its own counting logic instead of importing the lane-0 contract, and
the scaffold left orphan stubs — path-disjoint held, logic-DRY did not. **This is ONE run on ONE small
spec — it proves the greenfield flow works under real tokens, not that every greenfield holds.**



**✅ VERIFIED-ON-INSTALL, mostly (2026-06-30 — codex-cli 0.142.2 + gemini 0.49.0).** Codex + Gemini are
now installed + authenticated, and the three checklist items below were run against the real CLIs:

1. **Real multi-provider `--live` smoke** — ATTEMPTED (`scripts/smoke-xvendor.ts`), with an honest gap.
   The cross-vendor ROUTING is verified DETERMINISTICALLY (`cross-provider.test.ts`: with claude + codex
   available, the engineer routes → claude and the reviewer → codex, reviewer-differs-by-vendor), and all
   three CLIs detect installed+authed + codex runs real (standalone captures). BUT the live end-to-end
   handoff (claude builds → codex reviews over real tokens) was NOT reached: the bug-fix workflow
   consistently ESCALATED at the `repro` (test-author) stage — a doom-loop at retry-cap (3 claude runs
   `ok`, but the repro-red gate unsatisfied) — across 3 attempts; the feature workflow has no reviewer
   stage. So a real codex-reviews-claude invocation is **not yet demonstrated** → stays DEFERRED
   (`live-xvendor-handoff` — a `--live` repro-stage-gate issue, DISTINCT from the codex/gemini verification).
2. **Real `enforce()` unmet-set verification** — DONE, and it FOUND REAL MISTAKES (the point of the
   exercise): the mappings were RECONSTRUCTED and several were wrong. Both **too-loose** mappings
   (containment we claimed but didn't have) are fixed: **codex network:none** relied on a
   *user-config-overridable default* → now passes `-c sandbox_workspace_write.network_access=false`
   explicitly; **gemini network:none for builders** was "satisfied" by excluding web tools via
   `--exclude-tools` — *a flag that does not exist* → now UNMET (fail closed). Two **broken** flags that
   would have failed every real run (loud, not silent) are fixed: codex `--ask-for-approval` (rejected by
   `exec`) removed; gemini `--exclude-tools` replaced with `--approval-mode plan|yolo` + `--skip-trust`.
   Confirmed-correct strict mappings kept: codex `command-allowlist`/`no-exec` UNMET (coarse sandbox);
   gemini `command-allowlist` UNMET (Policy Engine out of scope).
3. **Stream fixtures re-captured** — codex `codex-exec.jsonl` is now a REAL capture (parser VERIFIED);
   gemini `gemini-stream.jsonl` has a real `init`/user envelope but an INFERRED assistant line (a clean
   capture was blocked by gemini API 503s).

**Still DEFERRED (named):** (a) `codex-on-PATH` — codex installs OFF-PATH so `whichSync` can't `detect()`
it without the bin on PATH; (b) `gemini-stream-recapture` — confirm the assistant/result stream event on
a clean (non-503) capture; (c) gemini per-command allowlist via the Policy Engine (`--policy`) — kept
strict/UNMET, not built. A wrong mapping is still either a needless Claude-pin (lost capability) or a
real **safety hole** (claimed containment that isn't there) — the two too-loose holes above were the
priority and are closed.

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
- **§5** — the engine speaks a neutral `ToolPolicy`; adapters' `enforce()→{args,unmet}` translate it (#25); the constraint-aware router picks the provider fail-closed, reviewer-must-differ / auditor-prefers, nothing-eligible → PARK (#26). Codex/Gemini `enforce()` mappings + the codex parser are now VERIFIED-ON-INSTALL vs the real CLIs (codex 0.142.2, gemini 0.49.0 — two too-loose holes fixed); a few sub-items stay deferred (codex-on-PATH, gemini-stream-recapture, gemini Policy-Engine allowlist — see above).
- **§6** — `phase` is load-bearing: a bootstrapping scratch project runs the greenfield workflow (phase-driven intake); `done` flips bootstrapping→maintenance, bound to reconcile's done-path; the scaffold BORNS the baseline so ticket #2 gets differential gating back (#27).
- **§7** — gates are real or convert to a blocking human gate (no silent no-op, #24); roster + gate-config assembled from triage data, not hardcoded per template; merge-conflict posture bounded-auto-resolve + blast-radius-escalates (#23); greenfield gating is ABSOLUTE (gate commands read from the worktree; integration-sweep is the MVP-exists gate with teeth); the MVP never auto-lands on `main` (#27). The `--live` greenfield smoke is **VERIFIED-BUDGET** (above — one capped run: a real architect invented a buildable MVP + 2 path-disjoint parallel lanes under the caps).
- **§9** — isolation is the lane model (one branch+worktree+gate-state per lane; sequential shared, fan-out isolated, #22); the integrator merges into `thalos/integration` only, never the default branch; conflict orchestration with the works-alone-breaks-together backstop (#23).
- **§11** — collab is a THREE-legged threat model (#29): executor-sandbox / host-gates+quarantine+differ-by-vendor / one-way data-confidentiality (minimize+inform, residual accepted); token + explicit human admit + revoke; creds never cross. The WIRE (separate authenticated `ws` endpoint, bound 127.0.0.1-only/off-loopback-throws; join→admit→revoke; pack→push→quarantine→host-git re-derive) is PROVEN two-process-on-one-machine over a real socket; cross-HOST networking + a peer genuinely jailing over the wire + a real provider over the wire stay DEFERRED-PENDING-MULTI-MACHINE (above).
- **§14** — the OS sandbox is the 4th, outermost defense-in-depth layer making pathScope+network:none REAL; "verified" = a real escape was DENIED (self-test, host-readback), never "binary present"; local = sandbox-when-available, collab = sandbox-REQUIRED fail-closed (#28). Linux (bubblewrap) real confinement is **VERIFIED-ON-LINUX** (2026-06-30: fs denied by host-readback, net by `ENETUNREACH` under `--unshare-net`) and macOS (sandbox-exec) is **VERIFIED-ON-MACOS** (2026-06-30, macOS 26.3 / arm64: both escapes denied with `EPERM`, hollow profile still fails); the collab peer-agent entrypoint + the over-the-wire round-trip from a verified box stay DEFERRED; per-domain network-allowlist deferred (only network:none is jail-enforceable).
- **§15** — OS sandboxing gates Phase 5 (ships with collab), not Phase 6.
- **CLAUDE.md** — gate toolchain pinned (Vitest/ESLint/tsc/Prettier) + aggregate `gate` + pre-commit hook (#16); migrate full schema up front, repositories only for tables a phase uses (#19).
