# Changelog

All notable changes to `ponytail-agy-band` are documented in this file.

## [Unreleased]

### Added
- Stale atomic write temporary file cleanup (`sweepStaleTempFiles`) inside `withLedgerLock` and `PONYTAIL_LOCK_TIMEOUT_MS` lock timeout override.
- CLI `--help` (`-h`) usage output and read-only `--status` diagnostic check mode (`inspectBandStatus`).
- CLI `--import` options `--project <name>` (repeatable project filter) and `--json` (machine-readable summary output).
- Support for hook `customLabel`/`title` session naming persisted across `Stop` and `--import`, plus `PONYTAIL_AGY_BRAIN_DIRS` environment override.

## [0.1.0] - 2026-11-15

### Added
- Native Antigravity (`agy`) plugin manifest ([`plugin.json`](./plugin.json)), SVG icon ([`assets/logo.svg`](./assets/logo.svg)), and lifecycle hooks ([`hooks.json`](./hooks.json)) for `SessionStart` and `Stop`.
- Companion importer skill [`/ponytail-agy-import`](./skills/ponytail-agy-import/SKILL.md) and CLI flag `--import` to backfill existing conversations across `~/.gemini/antigravity*/brain/`.
- Parent/child subagent transcript rollup, human wait exclusion (`ask_question`), idle-capped active agent minutes, and test pass/fail/stale tracking.
- Per-1M-token API cost estimation across Claude Code tariffs (read dynamically from installed Ponytail when present), Gemini 4 / 3.8 / 3.5 / 3.1 / 2.5 tariffs, and phase-aware Orchestrator rates (Carbon/Argon in plan mode, Hydrogen in execution mode), leaving `cost_usd` blank on `auto` or unknown models.
- Non-destructive per-project CSV upsert preserving Claude Code entries, Ponytail `board.ts` HTML rendering (via `module.stripTypeScriptTypes`), and standalone HTML fallback when Ponytail is not installed.
- Self-contained Node test suite (`node:test`) with zero external dependencies and cross-platform GitHub Actions CI.
