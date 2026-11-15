---
name: ponytail-agy-import
description: >
  Import past and active Antigravity (agy) sessions into Ponytail's local Board
  (~/.config/ponytail/band/board.html). Use when the user asks to refresh the
  ponytail board/dashboard with agy sessions or runs /ponytail-agy-import.
---

# Ponytail Agy Board Import

Syncs Antigravity (`agy`) conversation logs (`~/.gemini/antigravity*/brain/`) into Ponytail's per-project CSV ledgers (`~/.config/ponytail/band/*.csv`) and rebuilds `~/.config/ponytail/band/board.html` without overwriting Claude Code entries.

## Command

Run the importer bundled with this plugin (pass `--force` to bypass the incremental transcript cache, `--project <name>` to filter projects, `--json` for machine-readable output, `--status` for a read-only environment check, or `--help` for all options):

```bash
node --no-warnings ~/.gemini/config/plugins/ponytail-agy-band/hooks/sync-band.js --import
```

Report how many sessions were imported or updated and link `~/.config/ponytail/band/board.html` for the user.
