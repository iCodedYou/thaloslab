# Thalos Lab desktop shell (Tauri v2) — Phase 6

A **thin native window** over the loopback daemon UI. It is intentionally *not* a new application —
it wraps the exact same `http://127.0.0.1:8473` experience the browser already shows, so it adds **no
new trust surface**.

This directory is **not** a pnpm/JS package (no `package.json`) — it is a Rust/Tauri project, kept out
of the JS build graph. The native `tauri build` is **DEFERRED-PENDING-TOOLCHAIN** (no Rust/cargo/Tauri
CLI on the authoring box). The files here — `tauri.conf.json`, `capabilities/default.json`,
`src/main.rs`, `Cargo.toml` — **are the reviewable security artifact**, and they are mechanically
checked by `packages/cli/src/desktop-config.test.ts` (the config-lint).

## How it preserves the 127.0.0.1-only trust boundary

| Concern | What this shell does | Why it doesn't widen the boundary |
| --- | --- | --- |
| Where the UI loads | window `url` + `frontendDist` = `http://127.0.0.1:8473` | Same origin as `/api` + `/ws` ⇒ **no CORS** needed; the daemon never answers a non-loopback origin. |
| SPA delivery | Navigates to the **daemon-served** SPA | We do **not** bundle the SPA as `tauri://` assets — that would make `/api` cross-origin and force CORS (a new externally-shaped surface). |
| Daemon start | `setup` execs `thaloslab --no-open` (bundled sidecar) | Reuses the **proven** reuse-or-spawn lifecycle; **zero** lifecycle logic in Rust. The daemon's PID-idempotency backstop prevents a second instance. |
| Bind host | Never passed from here | Stays hardcoded `127.0.0.1` in the daemon. A LAN/`0.0.0.0` bind is a code + collab-admit security change, never a packaging default. |
| Native IPC | `withGlobalTauri:false`, `dangerousRemoteDomainIpcAccess:[]` | No IPC bridge is injected into the daemon page (which is *also* reachable in a plain browser); an SPA XSS cannot reach native. |
| Capabilities | `shell:allow-execute` scoped to the `thaloslab` sidecar only | No `shell:allow-open`, no `fs`/`http`, no unscoped exec. |
| Collab admit | The Collab tab calls the same `POST /api/collab/peers/:id/admit` | The explicit human-admit step is unchanged; the shell adds no collab surface. |

## Two claims, kept distinct

- **Proven now (no toolchain):** the config + capabilities are locked down, and the config-lint test
  asserts every footgun is disabled by parsing the actual JSON. This proves the trust-**preservation
  intent** and that the reviewable artifact is correct.
- **DEFERRED-PENDING-TOOLCHAIN:** only a real `tauri build` + a runtime smoke on a Rust box proves the
  **packaged app behaves** — that the window truly loads `127.0.0.1:8473`, the CSP is truly enforced by
  the webview, and the sidecar truly reuses the daemon. That on-hardware gate runs before this target
  ships.

## Building (on a Rust-equipped box)

```
# prerequisites: Rust toolchain + the Tauri v2 CLI + the platform webview deps
# bundle the thaloslab CLI as the `binaries/thaloslab` sidecar (per-target triple), then:
tauri build            # from packages/desktop
```
