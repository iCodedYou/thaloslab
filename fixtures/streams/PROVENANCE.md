# Provider stream fixtures — provenance (READ THIS)

These fixtures exercise the `codex.ts` / `gemini.ts` output parsers deterministically. Their
**provenance is the load-bearing fact** — and it now DIFFERS per fixture (some are real captures):

| Fixture | Captured from | Provenance | Status |
|---|---|---|---|
| `codex-exec.jsonl` | **codex-cli 0.142.2** | ✅ **REAL CAPTURE** — `codex exec --json` on a workspace-write task that ran a shell command (thread.started → turn.started → item.completed{agent_message} → item.started/completed{command_execution} → turn.completed{usage}) | **VERIFIED** |
| `gemini-stream.jsonl` | **gemini 0.49.0** | ⚠️ **ENVELOPE REAL, assistant INFERRED** — the `init` + `message{role:'user'}` lines are a real `gemini --output-format stream-json` capture; the `message{role:'assistant'}` line is INFERRED from that envelope (a clean assistant/result capture was blocked by gemini API **503s**) | **PARTIALLY-VERIFIED** (re-capture deferred) |
| `gemini-text.txt` | gemini (text mode) | reconstructed — exercises the tolerant non-JSON → stdout fallback path | reconstructed (fallback only) |

> ⚠️ `gemini-stream.jsonl`'s **assistant line is not a real capture** — gemini API 503s blocked a clean
> end-to-end stream. The stream-json *envelope* shape (`type`/`role`/`content`) IS real; the
> assistant/result handling stays **DEFERRED-PENDING-INSTALL (gemini-stream-recapture)** until a clean
> capture confirms the final-result event.

**What was verified on install (2026-06-30):** both adapters' `enforce()` mappings were checked against
the real `--help` + reality tests, and several reconstructed assumptions were WRONG and fixed (codex
`--ask-for-approval` rejected; codex network relied on a user-overridable default; gemini `--exclude-tools`
does not exist; gemini needs `--skip-trust`; gemini has `--output-format stream-json`). See the
`codex.ts` / `gemini.ts` headers and `conformance.test.ts`.

**Re-capture rule (unchanged):** if a fixture's stamped version differs from the installed CLI, treat
the fixture as STALE (re-capture), not just the code. Re-validate the parser + the `enforce()` unmet-set
against the real `--help`/sandbox docs.
