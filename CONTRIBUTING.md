# Contributing

Contributions to `ponytail-agy-band` are welcome under the terms of the [GNU General Public License v3.0 or later](./LICENSE).

## Prerequisites

- **Node.js `>= 22.6.0`** (uses built-in `module.stripTypeScriptTypes` and `node:test`)
- **Antigravity CLI (`agy`)** if validating the plugin layout locally

## Development Workflow

1. **Zero external dependencies:** keep `package.json` free of third-party runtime or dev dependencies so the plugin installs and runs directly from a single script.
2. **Run tests:**
   ```bash
   npm test
   ```
3. **Validate the Antigravity plugin layout:**
   ```bash
   agy plugin validate .
   ```
4. **No user-specific paths:** keep absolute local home paths out of tracked files (use `os.homedir()` or `~/` in docs); CI verifies this automatically.

## Pull Requests

- Keep changes focused, preserve upstream Claude Code CSV rows (`~/.config/ponytail/band/*.csv`), and include regression tests in [`tests/sync-band.test.js`](./tests/sync-band.test.js).
- Update [`CHANGELOG.md`](./CHANGELOG.md) when adding features or changing behavior.
