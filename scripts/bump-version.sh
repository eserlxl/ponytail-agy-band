#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Eser KUBALI
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Bump the plugin version in lockstep across plugin.json, package.json, and CHANGELOG.md.
# Updates files atomically and rolls back on failure; it does not create a git commit or tag.
#
# Usage:
#   scripts/bump-version.sh <major|minor|patch|X.Y.Z> [-m|--message "changelog note"] [--dry-run] [--gate]

set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_NAME="$(basename "$0")"

usage() {
  echo "Usage: ${SCRIPT_NAME} <major|minor|patch|X.Y.Z> [-m|--message \"changelog note\"] [--dry-run] [--gate]"
}

BUMP=""
NOTE=""
HAS_NOTE=0
DRY_RUN=""
GATE=""

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -m|--message)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        echo "bump-version: option $1 requires a non-empty value" >&2
        usage >&2
        exit 1
      fi
      NOTE="$2"
      HAS_NOTE=1
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --gate)
      GATE=1
      shift
      ;;
    -*)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [ -n "$BUMP" ]; then
        echo "Unexpected extra argument: $1" >&2
        usage >&2
        exit 1
      fi
      BUMP="$1"
      shift
      ;;
  esac
done

if [ -z "$BUMP" ]; then
  usage >&2
  exit 1
fi

if [ -n "$GATE" ]; then
  if ! (cd "$ROOT" && npm test); then
    echo "bump-version: gate failed (npm test) — refusing to bump" >&2
    exit 1
  fi
  if [ "${SKIP_AGY_VALIDATE:-0}" != "1" ] && command -v agy >/dev/null 2>&1; then
    if ! (cd "$ROOT" && agy plugin validate .); then
      echo "bump-version: gate failed (agy plugin validate) — refusing to bump" >&2
      exit 1
    fi
  fi
fi

if [ -z "$DRY_RUN" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  if [ "$(git -C "$ROOT" rev-parse --is-inside-work-tree 2>/dev/null || true)" = "true" ]; then
    if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
      echo "Working tree not clean; commit or stash first, or set ALLOW_DIRTY=1." >&2
      exit 1
    fi
  fi
fi

exec node - "$ROOT" "$BUMP" "$NOTE" "$HAS_NOTE" "${DRY_RUN:-0}" <<'JS'
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const [root, bump, note, hasNoteArg, dryRunArg] = process.argv.slice(2);
const hasUserNote = hasNoteArg === '1';
const dryRun = dryRunArg === '1';

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSemver(version) {
  const match = SEMVER_RE.exec(version);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4]
      ? match[4].split('.').map(id => (/^\d+$/.test(id) ? [0, Number(id), id] : [1, 0, id]))
      : null,
  };
}

function compareSemver(aStr, bStr) {
  const a = parseSemver(aStr);
  const b = parseSemver(bStr);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  const len = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i++) {
    const [typeA, numA, strA] = a.pre[i];
    const [typeB, numB, strB] = b.pre[i];
    if (typeA !== typeB) return typeA - typeB;
    if (typeA === 0) {
      if (numA !== numB) return numA - numB;
    } else if (strA !== strB) {
      return strA < strB ? -1 : 1;
    }
  }
  return a.pre.length - b.pre.length;
}

function splitLinesPreserve(text) {
  if (!text) return [];
  return text.match(/[^\n]*\n|[^\n]+/g) || [];
}

function computeNewVersion(pluginVer, pkgVer, bumpSpec) {
  if (pluginVer !== pkgVer) {
    if (bumpSpec === 'major' || bumpSpec === 'minor' || bumpSpec === 'patch') {
      fail(`bump-version: version mismatch between plugin.json (${pluginVer}) and package.json (${pkgVer}); align them or pass an explicit X.Y.Z target`);
    }
    if (!SEMVER_RE.test(bumpSpec)) {
      fail('bump must be one of: major | minor | patch | X.Y.Z');
    }
    const cmpPlug = compareSemver(bumpSpec, pluginVer);
    const cmpPkg = compareSemver(bumpSpec, pkgVer);
    const okPlug = cmpPlug > 0 || (cmpPlug === 0 && bumpSpec === pluginVer);
    const okPkg = cmpPkg > 0 || (cmpPkg === 0 && bumpSpec === pkgVer);
    if (!okPlug || !okPkg) {
      fail(`bump-version: target '${bumpSpec}' must be newer than current versions (${pluginVer}, ${pkgVer})`);
    }
    return { currentDisplay: `${pluginVer}/${pkgVer}`, newVersion: bumpSpec };
  }

  const parsed = parseSemver(pluginVer);
  const [maj, min, pat] = parsed.core;
  let nextVer;
  if (bumpSpec === 'major') nextVer = `${maj + 1}.0.0`;
  else if (bumpSpec === 'minor') nextVer = `${maj}.${min + 1}.0`;
  else if (bumpSpec === 'patch') nextVer = `${maj}.${min}.${pat + 1}`;
  else if (SEMVER_RE.test(bumpSpec)) {
    if (bumpSpec === pluginVer) {
      fail(`bump-version: ${bumpSpec} is already the current version; nothing to bump.`);
    }
    if (compareSemver(bumpSpec, pluginVer) <= 0) {
      fail(`bump-version: target '${bumpSpec}' must be newer than current version '${pluginVer}'`);
    }
    nextVer = bumpSpec;
  } else {
    fail('bump must be one of: major | minor | patch | X.Y.Z');
  }
  return { currentDisplay: pluginVer, newVersion: nextVer };
}

function planChangelogUpdate(changelogText, newVer, date) {
  const maskedText = changelogText.replace(/<!--[\s\S]*?(?:-->|$)/g, m => m.replace(/[^\r\n]/g, ' '));
  const lines = splitLinesPreserve(changelogText);
  const maskedLines = splitLinesPreserve(maskedText);

  const dupHeading = `## [${newVer}]`;
  if (maskedLines.some(ln => ln.startsWith(dupHeading))) {
    fail(`bump-version: CHANGELOG.md already has a ## [${newVer}] section; refusing to add a second.`);
  }

  const entryNote = hasUserNote ? note : 'Version bump.';
  const idx = maskedLines.findIndex(ln => ln.startsWith('## ['));
  const ensureTrailingNl = s => (s.endsWith('\n') ? s : `${s}\n`);

  if (idx === -1) {
    process.stderr.write("warning: no '## [' version section in changelog; appending entry at end\n");
    if (!hasUserNote) {
      process.stderr.write("warning: no drafted [Unreleased] notes and no -m — the entry will say only 'Version bump.'\n");
    }
    const block = `## [${newVer}] - ${date}\n\n### Changed\n- ${entryNote}\n`;
    const prefix = lines.join('');
    const sep = prefix.length === 0 ? '' : prefix.endsWith('\n\n') ? '' : prefix.endsWith('\n') ? '\n' : '\n\n';
    return {
      updatedText: `${prefix}${sep}${block}`,
      preview: block.trimEnd(),
    };
  }

  if (maskedLines[idx].trim().toLowerCase().startsWith('## [unreleased]')) {
    let nxt = lines.length;
    for (let j = idx + 1; j < lines.length; j++) {
      if (maskedLines[j].startsWith('## [')) {
        nxt = j;
        break;
      }
    }

    const bodyLines = lines.slice(idx + 1, nxt);
    const bodyMasked = maskedLines.slice(idx + 1, nxt);
    while (bodyLines.length > 0 && !bodyLines[0].trim()) {
      bodyLines.shift();
      bodyMasked.shift();
    }
    while (bodyLines.length > 0 && !bodyLines[bodyLines.length - 1].trim()) {
      bodyLines.pop();
      bodyMasked.pop();
    }

    const drafted = bodyMasked.some(ln => ln.trim().length > 0);
    const noted = bodyMasked.some(ln => ln.trim().length > 0 && !/^#{1,6}(?:\s|$)/.test(ln.trim()));

    let prefixUnderUnreleased = '';
    let releaseSection;
    let preview;

    if (drafted && !hasUserNote) {
      if (!noted) {
        process.stderr.write('warning: [Unreleased] holds only headings and no -m was given — the release entry will carry no notes\n');
      }
      bodyLines[bodyLines.length - 1] = ensureTrailingNl(bodyLines[bodyLines.length - 1]);
      releaseSection = `## [${newVer}] - ${date}\n\n${bodyLines.join('')}`;
      preview = `## [${newVer}] - ${date}\n(the drafted [Unreleased] notes follow)`;
    } else if (drafted && hasUserNote) {
      const k = bodyMasked.findIndex(ln => ln.trim().toLowerCase() === '### changed');
      if (k !== -1) {
        let end = bodyLines.length;
        for (let j = k + 1; j < bodyLines.length; j++) {
          if (/^\s*#/.test(bodyMasked[j])) {
            end = j;
            break;
          }
        }
        bodyLines[k] = ensureTrailingNl(bodyLines[k]);
        let at = k + 1;
        while (at < end && !bodyLines[at].trim()) at++;
        if (at >= end || !/^\s*(?:- |\* )/.test(bodyLines[at])) {
          at = k + 1;
        }
        bodyLines.splice(at, 0, `- ${note}\n`);
        bodyLines[bodyLines.length - 1] = ensureTrailingNl(bodyLines[bodyLines.length - 1]);
        releaseSection = `## [${newVer}] - ${date}\n\n${bodyLines.join('')}`;
        preview = `## [${newVer}] - ${date}\n- ${note}  (joins the drafted ### Changed)\n(the drafted [Unreleased] notes follow)`;
      } else {
        bodyLines[bodyLines.length - 1] = ensureTrailingNl(bodyLines[bodyLines.length - 1]);
        releaseSection = `## [${newVer}] - ${date}\n\n### Changed\n- ${note}\n\n${bodyLines.join('')}`;
        preview = `## [${newVer}] - ${date}\n\n### Changed\n- ${note}\n(the drafted [Unreleased] notes follow)`;
      }
    } else {
      if (!hasUserNote) {
        process.stderr.write("warning: no drafted [Unreleased] notes and no -m — the entry will say only 'Version bump.'\n");
      }
      if (bodyLines.length > 0) {
        bodyLines[bodyLines.length - 1] = ensureTrailingNl(bodyLines[bodyLines.length - 1]);
        prefixUnderUnreleased = `${bodyLines.join('')}\n`;
      }
      releaseSection = `## [${newVer}] - ${date}\n\n### Changed\n- ${entryNote}\n`;
      preview = `## [${newVer}] - ${date}\n\n### Changed\n- ${entryNote}`;
    }

    const head = lines.slice(0, idx).join('') + ensureTrailingNl(lines[idx]);
    const tail = nxt < lines.length ? `\n${lines.slice(nxt).join('')}` : '';
    const updatedText = `${head}\n${prefixUnderUnreleased}${releaseSection.replace(/\n+$/, '\n')}${tail}`;
    return { updatedText, preview };
  }

  if (!hasUserNote) {
    process.stderr.write("warning: no drafted [Unreleased] notes and no -m — the entry will say only 'Version bump.'\n");
  }
  const inserted = `## [${newVer}] - ${date}\n\n### Changed\n- ${entryNote}\n\n`;
  const updatedText = lines.slice(0, idx).join('') + inserted + lines.slice(idx).join('');
  return {
    updatedText,
    preview: inserted.trimEnd(),
  };
}

function atomicWriteFile(filePath, content, mode) {
  const dir = path.dirname(filePath);
  const rand = Math.random().toString(36).slice(2, 10);
  const tmpPath = path.join(dir, `.bump-${path.basename(filePath)}.tmp.${process.pid}.${rand}`);
  try {
    fs.writeFileSync(tmpPath, content, { mode: mode & 0o777 });
    fs.chmodSync(tmpPath, mode & 0o777);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    throw err;
  }
}

const pluginPath = path.join(root, 'plugin.json');
const pkgPath = path.join(root, 'package.json');
const changelogPath = path.join(root, 'CHANGELOG.md');

for (const reqPath of [pluginPath, pkgPath, changelogPath]) {
  if (!fs.existsSync(reqPath)) {
    fail(`Missing required file: ${reqPath}`);
  }
}

const originals = new Map();
const decoded = new Map();
const utf8 = new TextDecoder('utf-8', { fatal: true });

for (const targetPath of [pluginPath, pkgPath, changelogPath]) {
  const raw = fs.readFileSync(targetPath);
  const mode = fs.statSync(targetPath).mode;
  originals.set(targetPath, { raw, mode });
  try {
    decoded.set(targetPath, utf8.decode(raw));
  } catch {
    fail(`bump-version: ${path.relative(root, targetPath)} is not valid UTF-8; aborting before any edits`);
  }
}

let pluginObj;
let pkgObj;
try {
  pluginObj = JSON.parse(decoded.get(pluginPath));
} catch (err) {
  fail(`bump-version: plugin.json is not valid JSON (${err.message})`);
}
try {
  pkgObj = JSON.parse(decoded.get(pkgPath));
} catch (err) {
  fail(`bump-version: package.json is not valid JSON (${err.message})`);
}

if (!isPlainObject(pluginObj) || typeof pluginObj.version !== 'string' || !SEMVER_RE.test(pluginObj.version)) {
  fail(`bump-version: plugin.json must contain a valid SemVer 'version' string`);
}
if (!isPlainObject(pkgObj) || typeof pkgObj.version !== 'string' || !SEMVER_RE.test(pkgObj.version)) {
  fail(`bump-version: package.json must contain a valid SemVer 'version' string`);
}

const { currentDisplay, newVersion } = computeNewVersion(pluginObj.version, pkgObj.version, bump);
const date = new Date().toISOString().slice(0, 10);
const { updatedText: updatedChangelog, preview } = planChangelogUpdate(decoded.get(changelogPath), newVersion, date);

if (dryRun) {
  process.stdout.write(
    `dry-run: ${currentDisplay} -> ${newVersion} (files not modified)\n` +
      `  would update plugin.json -> ${newVersion}\n` +
      `  would update package.json -> ${newVersion}\n\n` +
      `Would add to CHANGELOG.md:\n${preview}\n`,
  );
  process.exit(0);
}

pluginObj.version = newVersion;
pkgObj.version = newVersion;

const updates = [
  [pluginPath, `${JSON.stringify(pluginObj, null, 2)}\n`, originals.get(pluginPath).mode],
  [pkgPath, `${JSON.stringify(pkgObj, null, 2)}\n`, originals.get(pkgPath).mode],
  [changelogPath, updatedChangelog, originals.get(changelogPath).mode],
];

const written = [];
try {
  for (const [targetPath, content, mode] of updates) {
    atomicWriteFile(targetPath, content, mode);
    written.push(targetPath);
  }
} catch (err) {
  const rollbackErrors = [];
  for (const targetPath of written.reverse()) {
    const orig = originals.get(targetPath);
    try {
      atomicWriteFile(targetPath, orig.raw, orig.mode);
    } catch (rbErr) {
      rollbackErrors.push(`${path.relative(root, targetPath)}: ${rbErr.message}`);
    }
  }
  if (rollbackErrors.length > 0) {
    fail(`bump-version: write failed (${err.message}) and rollback failed (${rollbackErrors.join('; ')})`);
  }
  fail(`bump-version: write failed (${err.message}); restored all modified files.`);
}

process.stdout.write(
  `Bumped: ${currentDisplay} -> ${newVersion}\n` +
    `  updated plugin.json\n` +
    `  updated package.json\n` +
    `  changelog entry added (${date})\n\n` +
    `Next: review the diff, commit, then refresh/reinstall in Antigravity (agy plugin install .).\n`,
);
JS
