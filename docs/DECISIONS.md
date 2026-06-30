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
| `DEFERRED-PENDING-INSTALL` | Codex/Gemini real `enforce()` mapping + stream-parser conformance (Phase 3) | run the real CLI: verify `unmet`-set vs `--help`, re-capture the stream fixtures |
| `DEFERRED-PENDING-BUDGET` | the `--live` greenfield smoke (Phase 4) | a manual capped build on real `pnpm` (≤2 lanes/300k tok/$5/15min/12 invokes; first cap ABORTS) |
| ✅ `VERIFIED-ON-LINUX` (2026-06-30) | real bubblewrap confinement (Phase 5) — **VERIFIED** | DONE: the real self-test's escape probe was genuinely DENIED on kernel `6.18.33.2-microsoft-standard-WSL2` + bubblewrap 0.11.1 — fs by host-readback, net by `ENETUNREACH` under `--unshare-net` ⇒ `selfTest().ok=true`; the router relaxation then un-pinned a Codex builder, while Noop re-pinned to Claude. See "Phase 5 sandbox — VERIFIED-ON-LINUX" below |
| `DEFERRED-PENDING-MACOS` | sandbox-exec/Lima (not yet implemented) (Phase 5) | the same self-test on macOS |
| `DEFERRED-PENDING-MULTI-MACHINE` | **cross-HOST** collab networking — NAT/tunnel (cloudflared/ngrok)/latency/a genuinely remote peer + the off-loopback bind (Phase 5). The WIRE itself (transport + protocol + trust state machine) is now PROVEN two-process-on-one-machine over a real socket; what remains is real *networking* between machines | a real second machine joins over the tunnel and runs the collab suite; the off-loopback bind opt-in implemented + reviewed |
| `DEFERRED` (collab — jail-over-wire) | a peer GENUINELY bubblewrap-jailing the host's task *over the wire* (Phase 5). The Wire D happy-path peer used a test SEAM (`confiningBackend`), NOT a real jail — it proves the wire + quarantine flow, not confinement-over-the-wire | run the peer-agent in WSL (the daemon stack on Linux) so its REAL bubblewrap jail (VERIFIED-ON-LINUX) confines a task arriving over the real socket |
| `DEFERRED` (collab — real-provider) | a REAL provider (Claude/Codex/Gemini) executing a peer's task over the wire with real tokens (Phase 5). The wire tests run the peer in `--mock` (deterministic, zero cost) | a capped `--live` collab smoke: a real CLI runs a peer's task end to end over the socket |
| `DEFERRED-PENDING-TOOLCHAIN` | the native Tauri `tauri build` + packaged-app runtime smoke (Phase 6) | on a Rust box: build the shell, confirm the window truly loads `127.0.0.1:8473`, the CSP is enforced by the webview, and the sidecar truly reuses the daemon (the config-lint proves the locked-down intent, not the running app) |
| `DEFERRED` (no target) | the per-domain network-allowlist filtering proxy (Phase 5) | n/a — only `network:none` is jail-enforceable, so `network:allowlist` stays Claude-pinned |

Until each is run-and-passed on real hardware, its subject stays at the safe posture already in place
(an unverified jail = NoopSandbox-equivalent → no router relaxation, collab fail-closed; an unverified
provider mapping = the mock's assumption, not a proof). Nothing below is overclaimed. **One item has now
cleared its gate: `DEFERRED-PENDING-LINUX` → `VERIFIED-ON-LINUX` (2026-06-30)** — the real bubblewrap
jail genuinely confined on a real kernel (details below).

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
(2026-06-30, above); macOS confinement and the REAL cross-machine wire remain deferred behind
self-tests/mocks that run **for real on-target before trust** — exactly like Phase 3's
deferred-pending-install. A reader must not mistake a *deferred* jail for a verified one — and the Linux
one is no longer deferred.

**Cross-platform sandbox — what is verified vs deferred:**

| OS | Backend | Verified on hardware? | Status |
|---|---|---|---|
| Linux | bubblewrap (rootless userns) — **implemented** | **YES** — kernel 6.18.x WSL2 + bwrap 0.11.1 (2026-06-30) | ✅ **VERIFIED-ON-LINUX** |
| macOS | sandbox-exec / Lima — not yet implemented | No | **DEFERRED-PENDING-MACOS** |
| Windows (this box) | WSL2 / Docker — neither present → **NoopSandbox** | n/a (no real jail) | local unsandboxed (DiD floor), collab fail-closed |

- **VERIFIED-ON-LINUX (2026-06-30):** the real bubblewrap jail's confinement was proven on a real Linux
  kernel (WSL2 6.18.x, bubblewrap 0.11.1, unprivileged userns available — `bwrap --ro-bind / / --unshare-all
  true` → exit 0). The real self-test genuinely DENIED both escapes — fs by host-readback (the probe's
  token never reached the host file), net by `ENETUNREACH` under `--unshare-net` — ⇒ `selfTest().ok=true`,
  and the router relaxation then un-pinned a Codex builder (Noop re-pinned to Claude). A permanent guarded
  test (`backends.test.ts`, `describe.runIf(linux+bwrap)`) re-runs this on any Linux box; it skips off-Linux
  so the Windows gate is unaffected. The exact jail flags: `bwrap --die-with-parent --new-session --unshare-{user,pid,ipc,uts}
  --ro-bind / / --tmpfs /tmp --proc /proc --dev /dev --bind <rw> <rw> --unshare-net`.
- **DEFERRED-PENDING-MACOS:** the future sandbox-exec/Lima jail's REAL confinement — the same self-test on
  macOS. Until then: present-but-unverified ⇒ treated as Noop (no relaxation, collab fail-closed).
- **DEFERRED-PENDING-MULTI-MACHINE (cross-HOST networking):** the WIRE is now PROVEN two-process-on-one-
  machine over a real socket — a separate authenticated `ws` endpoint (bound 127.0.0.1 only; off-loopback
  throws), the join handshake (token → explicit admit), per-frame revoke, and the full round-trip
  (pack → push → quarantine → host-git re-derive) against a real peer-agent. What stays DEFERRED is real
  *networking between machines*: NAT/tunnel (cloudflared/ngrok), latency, a genuinely remote peer, and the
  off-loopback bind. Two further collab items stay deferred and must NOT be read into "the wire is proven":
  a peer GENUINELY bubblewrap-jailing a task over the wire (the Wire D happy-path used a test SEAM, not a
  real jail — run it in WSL for the real thing), and a REAL provider executing a peer's task over the wire
  with real tokens (the wire tests use `--mock`). *First things to run when a second machine is available.*
- **DEFERRED (no target needed):** the per-domain network-allowlist filtering proxy — `network:none` is
  the only jail-enforceable posture, so a `network:allowlist` policy stays Claude-pinned even sandboxed.

**DEFERRED-PENDING-BUDGET (Phase 4 — the `--live` greenfield smoke).** Greenfield is the largest
single token spend in the project (a full MVP from nothing). The deterministic `--mock` bar is the
**standing proof** (the full run → done → flip, the *born baseline* via ticket #2, the
integration-sweep *teeth*, the absorbing partial-failure path). The **real `--live` greenfield smoke**
— a manual, opt-in, never-in-CI build of a deliberately tiny MVP that exercises discovery →
spec-gate → architect-invents-structure → multi-lane build on real `pnpm` — is **deferred pending an
explicit budget opt-in**, under a hard cap decided in advance: **≤ 2 seams/lanes, ≤ 300k output tokens
(≈ $5), ≤ 15 min, ≤ 12 agent invocations**; the **first cap hit ABORTS** the run (never runs away).
It validates the `detectGateCommands`-from-worktree path against a real package manager — the only
thing the mock bar can't. Until run, Phase 4 is *mechanically complete + deterministically proven,
real-agent-greenfield-unverified*.



**DEFERRED-PENDING-INSTALL (Phase 3 — Codex/Gemini not installed on the build machine).** Phase 3 is
mechanically complete and deterministically proven (router + parser LOGIC), but **live-unverified**
for Codex/Gemini until those CLIs are present. Before relying on them in `--live`:

1. **Real multi-provider `--live` smoke** — one ticket where the reviewer runs on a genuinely
   different installed provider than the engineer (the canary for flag/output drift).
2. **Verify each provider's real `enforce()` unmet-set** against the actual `codex`/`gemini`
   `--help` + sandbox docs. The mapping in `codex.ts`/`gemini.ts` is an ASSUMPTION — a wrong mapping
   is either a needless Claude-pin (mocked `unmet` but really capable) or a real **safety hole**
   (mocked met but really can't enforce). The mock validates router logic, never the mapping itself.
3. **Re-validate the stream fixtures** (`fixtures/streams/`) against the installed CLI version and
   **re-capture** them — they are RECONSTRUCTED from documented formats, not captured from a real
   run (see `fixtures/streams/PROVENANCE.md`). A fixture whose stamped version differs from the
   installed CLI is STALE (re-capture), not just the code.

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
- **§5** — the engine speaks a neutral `ToolPolicy`; adapters' `enforce()→{args,unmet}` translate it (#25); the constraint-aware router picks the provider fail-closed, reviewer-must-differ / auditor-prefers, nothing-eligible → PARK (#26). Codex/Gemini are live-unverified (DEFERRED-PENDING-INSTALL above).
- **§6** — `phase` is load-bearing: a bootstrapping scratch project runs the greenfield workflow (phase-driven intake); `done` flips bootstrapping→maintenance, bound to reconcile's done-path; the scaffold BORNS the baseline so ticket #2 gets differential gating back (#27).
- **§7** — gates are real or convert to a blocking human gate (no silent no-op, #24); roster + gate-config assembled from triage data, not hardcoded per template; merge-conflict posture bounded-auto-resolve + blast-radius-escalates (#23); greenfield gating is ABSOLUTE (gate commands read from the worktree; integration-sweep is the MVP-exists gate with teeth); the MVP never auto-lands on `main` (#27). The `--live` greenfield smoke is DEFERRED-PENDING-BUDGET (above).
- **§9** — isolation is the lane model (one branch+worktree+gate-state per lane; sequential shared, fan-out isolated, #22); the integrator merges into `thalos/integration` only, never the default branch; conflict orchestration with the works-alone-breaks-together backstop (#23).
- **§11** — collab is a THREE-legged threat model (#29): executor-sandbox / host-gates+quarantine+differ-by-vendor / one-way data-confidentiality (minimize+inform, residual accepted); token + explicit human admit + revoke; creds never cross. The WIRE (separate authenticated `ws` endpoint, bound 127.0.0.1-only/off-loopback-throws; join→admit→revoke; pack→push→quarantine→host-git re-derive) is PROVEN two-process-on-one-machine over a real socket; cross-HOST networking + a peer genuinely jailing over the wire + a real provider over the wire stay DEFERRED-PENDING-MULTI-MACHINE (above).
- **§14** — the OS sandbox is the 4th, outermost defense-in-depth layer making pathScope+network:none REAL; "verified" = a real escape was DENIED (self-test, host-readback), never "binary present"; local = sandbox-when-available, collab = sandbox-REQUIRED fail-closed (#28). Linux (bubblewrap) real confinement is **VERIFIED-ON-LINUX** (2026-06-30: fs denied by host-readback, net by `ENETUNREACH` under `--unshare-net`); macOS stays DEFERRED-PENDING-MACOS; per-domain network-allowlist deferred (only network:none is jail-enforceable).
- **§15** — OS sandboxing gates Phase 5 (ships with collab), not Phase 6.
- **CLAUDE.md** — gate toolchain pinned (Vitest/ESLint/tsc/Prettier) + aggregate `gate` + pre-commit hook (#16); migrate full schema up front, repositories only for tables a phase uses (#19).
