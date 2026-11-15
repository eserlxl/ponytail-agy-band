# Changelog

All notable changes to `ponytail-agy-band` are documented in this file.

## [Unreleased]

### Added
- Incremental stat-validated transcript caching (`.agy-import-cache.json`) for `importAllBrains` / `--import`, plus `--force` rebuild option.
- Stale atomic write temporary file cleanup (`sweepStaleTempFiles`) inside `withLedgerLock` and `PONYTAIL_LOCK_TIMEOUT_MS` lock timeout override.
- CLI `--help` (`-h`) usage output and read-only `--status` diagnostic check mode (`inspectBandStatus`), including Ponytail `board.ts` compile diagnostics (`boardCompileError` on load/export failures) and single-read `defaultPonytailLevel()` reuse (`defaultLevel`) across `importAllBrains`.
- CLI `--import` options `--project <name>` (repeatable project filter) and `--json` (machine-readable summary output), plus strict CLI flag/mode validation (`parseCliArgs`) exiting fast with exit code `2` and stderr hint on unknown flags, positional args, `--option=value` syntax, missing values, `--status` combined with `--force`/`--project`, or conflicting modes (`--help` precedence preserved), and synchronous CLI output flushing before exit.
- Support for hook `customLabel`/`title` session naming persisted across `Stop` and `--import`, plus `PONYTAIL_AGY_BRAIN_DIRS` environment override.
- `README.md` `Troubleshooting` runbook, CLI exit code documentation, and `PONYTAIL_AGY_ALLOW_TEMP` environment table entry aligned with `skills/ponytail-agy-import/SKILL.md`.

### Fixed
- `inspectBandStatus` and `importAllBrains` honor explicit empty `brainDirs: []` arrays instead of falling back to default brain directories or treating empty scans as global pruning sweeps.
- Corrupt non-object JSON (`null`, `[]`, primitives) in `.agy-sessions.json` and `.agy-import-cache.json` is safely normalized and repaired instead of throwing or dropping hook metadata.
- `withLedgerLock` uses per-holder ownership tokens and serialized stale-lock reaping to prevent active-lock reclamation races, and `writeAtomic` unlinks temporary files immediately on write/rename failure.
- `importAllBrains` and `Stop` hooks remove stale standalone child subagent CSV rows when rolling descendants into their parent conversation so child usage is never double-counted.
- Malformed hook stdin payloads (including UTF-8 BOM-prefixed `Stop` events) preserve `{ decision: 'allow' }` fail-open output on `Stop` turns without aborting hooks.
- Unfiltered `importAllBrains` / `--import` scans prune vanished session entries from `.agy-import-cache.json` strictly scoped to the scanned `brainDirs` (and compact 0-session entries) while preserving `--project` and sibling-directory entries.
- Unfiltered `importAllBrains` / `--import` scans prune expired or corrupt absent-transcript entries from `.agy-sessions.json` under `withLedgerLock` (TTL-gated) while retaining active sessions and fresh `SessionStart` metadata.

## [0.1.0] - 2026-11-15

### Added
- Native Antigravity (`agy`) plugin manifest ([`plugin.json`](./plugin.json)), SVG icon ([`assets/logo.svg`](./assets/logo.svg)), and lifecycle hooks ([`hooks.json`](./hooks.json)) for `SessionStart` and `Stop`.
- Companion importer skill [`/ponytail-agy-import`](./skills/ponytail-agy-import/SKILL.md) and CLI flag `--import` to backfill existing conversations across `~/.gemini/antigravity*/brain/`.
- Parent/child subagent transcript rollup, human wait exclusion (`ask_question`), idle-capped active agent minutes, and test pass/fail/stale tracking.
- Per-1M-token API cost estimation across Claude Code tariffs (read dynamically from installed Ponytail when present), Gemini 4 / 3.8 / 3.5 / 3.1 / 2.5 tariffs, and phase-aware Orchestrator rates (Carbon/Argon in plan mode, Hydrogen in execution mode), leaving `cost_usd` blank on `auto` or unknown models.
- Non-destructive per-project CSV upsert preserving Claude Code entries, Ponytail `board.ts` HTML rendering (via `module.stripTypeScriptTypes`), and standalone HTML fallback when Ponytail is not installed.
- Self-contained Node test suite (`node:test`) with zero external dependencies and cross-platform GitHub Actions CI.
