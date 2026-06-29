# Provider stream fixtures — provenance (READ THIS)

These fixtures exercise the `codex.ts` / `gemini.ts` output parsers deterministically. Their
**provenance is the load-bearing fact**:

> ⚠️ **RECONSTRUCTED, NOT CAPTURED.** Codex and Gemini are **not installed** on the machine this
> phase was built on, so none of these samples were captured from a real CLI run. They are
> **reconstructed from the documented output formats at the 2026-01 knowledge cutoff**. A fixture
> hand-authored to match our own parser proves the parser is self-consistent with our *assumed*
> format — it does **not** prove the parser handles **real** CLI output.

So the conformance test that reads these is **conformance-UNVERIFIED**: it proves parser logic
against the assumed shape, never real-output conformance. See the DEFERRED-PENDING-INSTALL checklist
in `docs/DECISIONS.md`.

| Fixture | Targets CLI version | Provenance | Status |
|---|---|---|---|
| `codex-exec.jsonl` | codex `0.x` (assumed) | reconstructed from the documented `codex exec --json` event schema | conformance-UNVERIFIED |
| `gemini-text.txt` | gemini `0.x` (assumed) | reconstructed from the documented headless `gemini --prompt` text output | conformance-UNVERIFIED |
| `gemini-json.jsonl` | gemini `0.x` (assumed) | reconstructed from the documented structured output variant | conformance-UNVERIFIED |

**On install, before relying on these in `--live`:** re-capture each fixture from a real CLI run of
the installed version, update the version stamp, and re-validate the parser + the `enforce()`
unmet-set against the real `--help`/sandbox docs. If a fixture's stamped version differs from the
installed CLI version, treat the fixture as STALE (needs re-capture), not just the code.
