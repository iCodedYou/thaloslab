// Thalos Lab desktop shell (SPEC §15, Phase 6) — a THIN native window over the loopback daemon UI.
//
// TRUST BOUNDARY (do not widen): this shell adds NO network surface and NO new lifecycle logic.
//   - The window loads http://127.0.0.1:8473 (configured in tauri.conf.json) — the SAME origin the
//     daemon serves the SPA + /api + /ws from. Same-origin ⇒ the daemon needs no CORS; its
//     "no external origin is ever admitted" posture is preserved by construction.
//   - The daemon is started by EXEC-ing the proven `thaloslab --no-open` launcher (the CLI), which
//     does the reuse-or-spawn lifecycle (readLockfile → health-ping → reuse, else spawn detached +
//     wait). This shell replicates ZERO of that logic — the "second daemon" bug lives only in a
//     reimplementation, and the daemon's own PID-idempotency backstop is the final guard.
//   - The daemon bind host is NOT passed from here. It stays hardcoded 127.0.0.1 in the daemon.
//     Enabling any LAN/0.0.0.0 bind is a code + collab-admit security change under review — never a
//     packaging convenience reachable from this shell or its config.
//
// NOTE: this is the reviewable source artifact. The native `tauri build` (and a runtime smoke that
// the window truly loads 127.0.0.1:8473 and the CSP is truly enforced by the webview) is
// DEFERRED-PENDING-TOOLCHAIN — it runs on a Rust-equipped box before the desktop target ships.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Exec the bundled launcher sidecar. `thaloslab --no-open` reuses a healthy daemon or
            // starts one and blocks until it is healthy — then exits. We do not parse a port or
            // touch the lockfile here; the window URL is the fixed loopback origin and the daemon's
            // EADDRINUSE fallback keeps it on 127.0.0.1. Zero lifecycle logic is duplicated.
            let sidecar = app
                .shell()
                .sidecar("thaloslab")
                .expect("thaloslab launcher sidecar must be bundled (bundle.externalBin)")
                .args(["--no-open"]);

            tauri::async_runtime::spawn(async move {
                match sidecar.spawn() {
                    Ok((mut rx, _child)) => {
                        // Drain the launcher's output until it exits (daemon healthy or failed).
                        while let Some(event) = rx.recv().await {
                            if let CommandEvent::Terminated(_) = event {
                                break;
                            }
                        }
                    }
                    Err(e) => eprintln!("failed to launch daemon via thaloslab sidecar: {e}"),
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Thalos Lab desktop shell");
}
