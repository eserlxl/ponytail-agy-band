# ponytail-agy-band

Companion Antigravity (`agy`) telemetry plugin for [Ponytail](https://github.com/DietrichGebert/ponytail)'s local Board (`~/.config/ponytail/band/board.html`).

Upstream Ponytail logs Claude Code sessions through its `claude-code` Band listener and `~/.claude/projects` importer. `ponytail-agy-band` stays completely separate so Ponytail upgrades never overwrite it: it captures live `agy` turns via Antigravity lifecycle hooks, backfills historical `agy` conversations into the same per-project CSV ledgers, preserves existing Claude Code rows, and rebuilds `board.html`.

## Features

- **Live sync via `agy` hooks** ([`hooks.json`](./hooks.json)): runs on `SessionStart` (capturing initial workspace path and model) and `Stop` (parsing the updated transcript and refreshing `board.html`).
- **Historical backfill** ([`/ponytail-agy-import`](./skills/ponytail-agy-import/SKILL.md) or `--import`): scans `~/.gemini/antigravity*/brain/`, rolls child subagent transcripts up into their parent conversation, and deduplicates rows by session ID prefix.
- **Claude + `agy` unified ledger**: updates `~/.config/ponytail/band/<project>.csv` atomically without altering existing Claude Code rows, and cleans up stale `antigravity.csv` fallback entries once a session's project resolves.
- **Works with or without Ponytail installed**: dynamically discovers Ponytail across `.gemini/config/plugins`, `.gemini/extensions`, `.codex/plugins`, and `.claude/plugins/cache`, renders via Ponytail's `hooks/band/board.ts` when available, and falls back to a built-in standalone HTML board otherwise.
- **Zero dependencies**: plain Node.js (`>= 22.6.0`).

## Install

Install from GitHub with Antigravity CLI:

```bash
agy plugin install https://github.com/eserlxl/ponytail-agy-band
```

Or install from a local checkout:

```bash
agy plugin install /path/to/ponytail-agy-band
```

Restart or start a new `agy` session after installation so `SessionStart` and `Stop` hooks become active.

## Importing Past Sessions

Invoke `/ponytail-agy-import` inside an `agy` session, or run the script directly:

```bash
node --no-warnings ~/.gemini/config/plugins/ponytail-agy-band/hooks/sync-band.js --import
```

## Metrics & Pricing Rules

- **Tokens & Turns**: aggregates `input_tokens`, `cache_read_tokens`, and `output_tokens` across human-driven turns that receive a model response (skipping unanswered local inputs while counting slash-invoked agent turns) and sums any spawned child subagents (`invoke_subagent` / `swarm`) into the parent task.
- **Agent Minutes**: sums step deltas capped at a 30-minute idle threshold (`IDLE_MS`) while excluding time waiting on human input (`ask_question`).
- **Test Status**: tracks test commands (`node --test`, `pytest`, `npm test`, `cargo test`, etc., including async background completions) and flips status to `stale` if non-test source files are subsequently edited without re-running tests.
- **Cost Estimation**: when the active model is known (from `Model Selection` transcript updates or non-`"auto"` hook `modelName`), estimates API cost using public per-1M-token tariffs (loading Claude Code rates from installed Ponytail when present, plus Gemini `4 / 3.8 / 3.5 / 3.1 / 2.5` and phase-aware Orchestrator Carbon/Argon -> Hydrogen execution rates). When the model is unknown or `"auto"`, leaves `cost_usd` blank and labels the model `"Agy"`.
- **Hyphen-safe Model Labels**: Ponytail's Board frontend splits model strings on `-` and drops multi-character hyphenated words, so labels use spaces and middle dots (for example `Agy · Orchestrator (Carbon)`, `Agy · Gemini 3.8 Flash`, `Agy · Opus 5.5`).

## CLI Options & Environment Variables

| Option / Variable | Description |
| :--- | :--- |
| `--import` | Scan all `agy` brain directories and rebuild `~/.config/ponytail/band/board.html` |
| `--force` | Bypass incremental transcript stat cache (`.agy-import-cache.json`) and re-parse all transcripts |
| `--status` | Inspect discovered brain directories, ledger CSVs, and board mode without modifying disk state |
| `-h`, `--help` | Print CLI usage summary and exit `0` |
| `--brain-dir <path>` | Override brain directories to scan (repeatable) |
| `--ledger-dir <path>` | Override target CSV + `board.html` directory |
| `--ponytail-dir <path>` | Override installed Ponytail plugin directory |
| `--project <name>` | Filter `--import` to a specific project basename (repeatable, case-insensitive) |
| `--json` | Emit `--import` or `--status` summary as single-line JSON on stdout |
| `PONYTAIL_BAND_DIR` | Default ledger directory override (otherwise `$XDG_CONFIG_HOME/ponytail/band`) |
| `PONYTAIL_PLUGIN_DIR` | Installed Ponytail plugin directory override |
| `PONYTAIL_AGY_BRAIN_DIRS` | Delimiter-separated (`:` / `;`) brain directory paths used by default `--import` scans |
| `PONYTAIL_LOCK_TIMEOUT_MS` | Positive integer lock wait timeout in milliseconds for ledger writes (default `5000`) |
| `PONYTAIL_DEFAULT_MODE` | Fallback Ponytail level (`lite`, `full`, `ultra`, `off`) |

CLI exit codes: `0` on normal completion (`-h`/`--help`, `--import`, `--status`, or stdin hook mode with no arguments), or `2` on invalid/unknown flags, positional arguments, `--option=value` syntax (use space-separated `--option <value>`), missing values, or conflicting/incomplete mode combinations.

## Troubleshooting

- **Standalone board / `boardCompileError`**: Run `node --no-warnings ./hooks/sync-band.js --status` (or append `--json`). If Ponytail sources are absent or fail to compile, `boardMode` falls back to `standalone` and `boardCompileError` prints the failure details; update Ponytail or override `--ponytail-dir` / `PONYTAIL_PLUGIN_DIR`.
- **Stale cache or missing sessions**: Pass `--import --force` to rebuild `.agy-import-cache.json` from transcripts on disk. Unfiltered default/`PONYTAIL_AGY_BRAIN_DIRS` `--import` scans automatically prune disappeared sessions from cache and expired absent entries from `.agy-sessions.json` (scoped `--project` and explicit `--brain-dir` runs leave shared metadata untouched).
- **Lock contention & temp files**: Keep `PONYTAIL_LOCK_TIMEOUT_MS` under ~`7000` ms when hooks run under `hooks.json` (`10`s `SessionStart` / `15`s `Stop`), since `Stop` can lock twice for metadata and CSV writes; stale `.agy-band.lock` and `*.tmp.*` files under `$XDG_CONFIG_HOME/ponytail/band` (or `~/.config/ponytail/band`) older than 15s are cleaned automatically, and hook invocations fail open.
- **CLI exit code `2` & `antigravity.csv` rows**: Exit code `2` flags bad options, `--option=value` syntax (use `--option <value>`), missing values, or mode conflicts — check `--help`. Early turns placed in `antigravity.csv` are automatically removed when a session resolves to `<project>.csv`.

## Development & Testing

```bash
npm test
agy plugin validate .
```

## Uninstall

```bash
agy plugin uninstall ponytail-agy-band
```

## License

Copyright (C) 2026 Eser KUBALI. Licensed under the [GNU General Public License v3.0 or later](./LICENSE) (`GPL-3.0-or-later`).
