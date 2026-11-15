#!/usr/bin/env node
// ponytail-agy-band — Syncs Antigravity (agy) sessions into Ponytail's local Board ledger.
// SPDX-FileCopyrightText: 2026 Eser KUBALI
// SPDX-License-Identifier: GPL-3.0-or-later

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

const CSV_HEADER =
  'key,started,project,name,cost_usd,turns,agent_minutes,tokens_total,tokens_output,reuse_pct,reused,new,callers_open,tests,level,model';

const IDLE_MS = 30 * 60000;
const STDIN_TIMEOUT_MS = 4000;
const SKIP_SOURCE_DIR =
  /(^|\/)(node_modules|\.git|dist|build|out|vendor|venv|\.venv|__pycache__|coverage|\.next|target|migrations|fixtures|tests?|__tests__|spec)(\/|$)/;
const SKIP_TEST_FILE =
  /(^|\/)(test_[^/]*|[^/]*(_test|\.test|\.spec|\.gen|\.min|\.d)\.[a-z]+)$/;
const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|sh|php|java|c|cpp|h|hpp)$/i;
const TEST_CMD =
  /\b(npm (run )?test|pnpm (run )?test|yarn test|bun test|npx (jest|vitest)|jest|vitest|pytest|python3? -m pytest|go test|cargo test|mvn test|gradle test|rspec|phpunit|dotnet test|node(?: --[\w-]+)* --test|deno test|make test|tests\/run\.sh|release-gate\.sh|lint-gate\.sh|mutation-gate\.sh)\b/;
const TEMP_PREFIXES = [os.tmpdir(), '/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/'];
const SYSTEM_SKIP_PREFIXES = ['/proc/', '/sys/', '/dev/', '/usr/', '/bin/', '/sbin/', '/lib/', '/etc/', '/opt/google/'];
const WORKTREE_SPLIT_RE = /[\\/](?:\.claude[\\/]worktrees|\.worktrees|\.git[\\/]worktrees)[\\/]/;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// Built-in Claude Code tariffs matching Ponytail's ponytail-band-import.js:
// [input, 5m-cache-write, 1h-cache-write, cache-read, output] per 1M tokens.
const OPUS_DEFAULT = [5, 6.25, 10, 0.5, 25];
const BUILTIN_CLAUDE_PRICES = {
  'claude-fable-5-1': [10, 12.5, 20, 0.25, 50],
  'claude-fable-5': [10, 12.5, 20, 1, 50],
  'claude-opus-5-5': [4, 5, 8, 0.2, 20],
  'claude-opus-5': OPUS_DEFAULT,
  'claude-opus-4-8': OPUS_DEFAULT,
  'claude-opus-4-7': OPUS_DEFAULT,
  'claude-opus-4-6': OPUS_DEFAULT,
  'claude-opus-4-5': OPUS_DEFAULT,
  'claude-sonnet-5-5': [2, 2.5, 4, 0.1, 10],
  'claude-sonnet-5': [2, 2.5, 4, 0.2, 10],
  'claude-sonnet-4-6': [3, 3.75, 6, 0.3, 15],
  'claude-sonnet-4-5': [3, 3.75, 6, 0.3, 15],
  'claude-haiku-5-5': [0.1, 0.125, 0.2, 0.01, 0.5],
  'claude-haiku-4-5': [1, 1.25, 2, 0.1, 5],
};

function defaultLedgerDir() {
  if (process.env.PONYTAIL_BAND_DIR) return process.env.PONYTAIL_BAND_DIR;
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'ponytail', 'band');
}

/** Discover the installed Ponytail plugin directory across supported agent hosts. */
function defaultPonytailDir() {
  if (process.env.PONYTAIL_PLUGIN_DIR) return process.env.PONYTAIL_PLUGIN_DIR;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.gemini', 'config', 'plugins', 'ponytail'),
    path.join(home, '.gemini', 'extensions', 'ponytail'),
    path.join(home, '.codex', 'plugins', 'ponytail'),
  ];
  const claudeCacheBase = path.join(home, '.claude', 'plugins', 'cache', 'ponytail', 'ponytail');
  try {
    if (fs.existsSync(claudeCacheBase)) {
      const versions = fs
        .readdirSync(claudeCacheBase, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
      for (const ver of versions) candidates.push(path.join(claudeCacheBase, ver));
    }
  } catch {}
  candidates.push(claudeCacheBase);

  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'hooks', 'band', 'board.ts'))) return dir;
    } catch {}
  }
  return candidates[0];
}

function defaultBrainDirs() {
  const envDirs = (process.env.PONYTAIL_AGY_BRAIN_DIRS || '').trim();
  if (envDirs) {
    const dirs = [];
    for (const raw of envDirs.split(path.delimiter)) {
      const p = raw.trim();
      if (!p) continue;
      try {
        if (fs.existsSync(p) && fs.statSync(p).isDirectory() && !dirs.includes(p)) dirs.push(p);
      } catch {}
    }
    return dirs;
  }
  const dirs = [];
  for (const name of ['antigravity-cli', 'antigravity', 'antigravity-ide']) {
    const p = path.join(os.homedir(), '.gemini', name, 'brain');
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) dirs.push(p);
    } catch {}
  }
  return dirs;
}

function defaultPonytailLevel() {
  const envMode = (process.env.PONYTAIL_DEFAULT_MODE || '').trim().toLowerCase();
  if (['lite', 'full', 'ultra', 'off'].includes(envMode)) return envMode;
  try {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    const cfg = JSON.parse(fs.readFileSync(path.join(xdg, 'ponytail', 'config.json'), 'utf8'));
    const mode = typeof cfg.defaultMode === 'string' ? cfg.defaultMode.trim().toLowerCase() : '';
    if (['lite', 'full', 'ultra', 'off'].includes(mode)) return mode;
  } catch {}
  return 'full';
}

let atomicSeq = 0;
const SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));
const activeLedgerLocks = new Map();

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${++atomicSeq}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Serialize read-modify-write ledger mutations across concurrent hook/import processes. */
function withLedgerLock(ledgerDir, fn, timeoutMs = 5000, staleMs = 15000) {
  const key = path.resolve(ledgerDir);
  const depth = activeLedgerLocks.get(key) || 0;
  if (depth > 0) {
    activeLedgerLocks.set(key, depth + 1);
    try {
      return fn();
    } finally {
      activeLedgerLocks.set(key, depth);
    }
  }

  fs.mkdirSync(ledgerDir, { recursive: true });
  const lockPath = path.join(ledgerDir, '.agy-band.lock');
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, `${process.pid}\n`);
      } finally {
        fs.closeSync(fd);
      }
      acquired = true;
      break;
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ledger lock: ${lockPath}`);
      }
      Atomics.wait(SLEEP_VIEW, 0, 0, 15);
    }
  }

  activeLedgerLocks.set(key, 1);
  try {
    return fn();
  } finally {
    activeLedgerLocks.delete(key);
    if (acquired) fs.rmSync(lockPath, { force: true });
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

const cachedClaudePrices = new Map();
function getClaudePrices(ponytailDir) {
  const dir = ponytailDir || defaultPonytailDir();
  const key = path.resolve(dir);
  if (cachedClaudePrices.has(key)) return cachedClaudePrices.get(key);
  const importer = path.join(dir, 'hooks', 'ponytail-band-import.js');
  let prices = BUILTIN_CLAUDE_PRICES;
  try {
    if (fs.existsSync(importer)) {
      const mod = require(importer);
      if (mod && mod.PRICES && typeof mod.PRICES === 'object') {
        prices = { ...BUILTIN_CLAUDE_PRICES, ...mod.PRICES };
      }
    }
  } catch {}
  cachedClaudePrices.set(key, prices);
  return prices;
}

function unwrapArg(val) {
  if (typeof val !== 'string') return val;
  const s = val.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
    try {
      return JSON.parse(s);
    } catch {
      return val;
    }
  }
  return val;
}

function streamJsonl(filePath, onRecord) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(1 << 20);
  const dec = new StringDecoder('utf8');
  let rest = '';
  const take = line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      return;
    }
    onRecord(record);
  };
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) {
      const parts = (rest + dec.write(buf.subarray(0, n))).split('\n');
      rest = parts.pop() || '';
      for (const part of parts) take(part);
    }
    take(rest + dec.end());
  } finally {
    fs.closeSync(fd);
  }
}

/** Stream JSONL records once per file when a per-run record cache is supplied. */
function streamTranscriptRecords(filePath, onRecord, recordCache) {
  if (!recordCache) {
    streamJsonl(filePath, onRecord);
    return;
  }
  const key = path.resolve(filePath);
  let cached = recordCache.get(key);
  if (!cached) {
    cached = [];
    streamJsonl(filePath, r => {
      cached.push({
        created_at: r.created_at,
        source: r.source,
        type: r.type,
        content: r.content,
        input_tokens: r.input_tokens,
        cache_read_tokens: r.cache_read_tokens,
        output_tokens: r.output_tokens,
        tool_calls: r.tool_calls,
      });
    });
    recordCache.set(key, cached);
  }
  for (const r of cached) onRecord(r);
}

/** Resolve the main repository root directory via `git --git-common-dir`, or null. */
function gitCommonRoot(dir) {
  const git = spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  });
  return git.status === 0 && /[\\/]\.git$/.test(git.stdout.trim()) ? path.dirname(git.stdout.trim()) : null;
}

/** Normalize an agent worktree path back to its parent repository root when present. */
function stripWorktreeSegment(p) {
  return String(p || '').split(WORKTREE_SPLIT_RE)[0];
}

function resolveGitRoot(candidatePath, gitCache) {
  let d = stripWorktreeSegment(candidatePath);
  try {
    while (d && path.dirname(d) !== d && !fs.existsSync(d)) d = path.dirname(d);
    if (!d || path.dirname(d) === d) return null;
    if (fs.statSync(d).isFile()) d = path.dirname(d);
  } catch {
    return null;
  }
  if (!d || path.dirname(d) === d) return null;
  if (!gitCache) return gitCommonRoot(d);
  if (!gitCache.has(d)) {
    gitCache.set(d, gitCommonRoot(d));
  }
  return gitCache.get(d);
}

function projectOf(cwd, cache, gitCache) {
  if (!cwd) return 'antigravity';
  if (!cache.has(cwd)) {
    const clean = stripWorktreeSegment(cwd);
    let root = clean;
    if (fs.existsSync(clean)) {
      root = resolveGitRoot(clean, gitCache) || clean;
    } else {
      let probe = clean;
      while (probe && path.dirname(probe) !== probe && !fs.existsSync(probe)) {
        probe = path.dirname(probe);
      }
      const gitRoot = probe && path.dirname(probe) !== probe ? resolveGitRoot(probe, gitCache) : null;
      if (gitRoot) root = gitRoot;
    }
    const base = path.basename(root.replace(/[\\/]+$/, ''));
    cache.set(cwd, base || 'antigravity');
  }
  return cache.get(cwd);
}

function isIgnoredWorkspacePath(p, allowTempWorkspaces = false) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return true;
  const trimmed = p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
  if (!trimmed) return true;
  const norm = trimmed.replace(/\\/g, '/');
  const home = os.homedir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm === '/' || norm === '/home' || norm === home) return true;
  if (norm.includes('/.gemini/') || norm.endsWith('/.gemini')) return true;
  const withSlash = `${norm}/`;
  if (
    !allowTempWorkspaces &&
    (TEMP_PREFIXES.some(t => {
      const prefix = t.replace(/\\/g, '/').replace(/\/+$/, '');
      return prefix && (norm === prefix || withSlash.startsWith(`${prefix}/`));
    }) ||
      norm === '/tmp')
  ) {
    return true;
  }
  if (SYSTEM_SKIP_PREFIXES.some(s => withSlash.startsWith(s))) return true;
  return false;
}

function extractCommandPaths(cmd) {
  if (typeof cmd !== 'string') return [];
  const matches = cmd.match(/(?:^|[\s"'=])(\/(?:home|opt|srv|var\/www|Users)\/[^\s"'`;|&<>()]+)/g) || [];
  return matches.map(m => m.replace(/^[\s"'=]+/, '').replace(/[.,;:]+$/, ''));
}

function extractPromptTitle(content) {
  if (typeof content !== 'string') return '';
  let text = '';
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
  if (m) {
    text = m[1];
  } else {
    text = content
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
      .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
      .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, '');
  }
  const line = text
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !l.startsWith('<') && !l.startsWith('/'));
  return line ? line.slice(0, 60) : '';
}

function extractRawPromptText(content) {
  if (typeof content !== 'string') return '';
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
  return (m ? m[1] : content).trim();
}

function detectModelChange(content) {
  if (typeof content !== 'string') return null;
  const m = /changed setting `Model Selection` from [^\n]+? to ([^\n<]+?)(?=\.(?:\s|$|<)|$|\n|<)/.exec(content);
  return m ? m[1].trim() : null;
}

function normalizeClaudeId(model) {
  let s = String(model || '')
    .trim()
    .toLowerCase()
    .replace(/\s*\((?:high|medium|low|xhigh|max)\)\s*$/i, '')
    .replace(/-(?:high|medium|low|xhigh|max)$/i, '')
    .replace(/\[.*\]$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/[\s.]+/g, '-');
  if (!s.startsWith('claude-') && /^(?:opus|sonnet|haiku|fable)-/.test(s)) {
    s = `claude-${s}`;
  }
  return s;
}

function estimateStepCost(model, inExecPhase, inputTokens, cacheReadTokens, outputTokens, ponytailDir) {
  const raw = String(model || '').trim().toLowerCase();
  if (!raw || raw === 'auto' || raw === 'none') return null;

  const claudePrices = getClaudePrices(ponytailDir);
  const claudeId = normalizeClaudeId(raw);
  if (claudePrices[claudeId]) {
    const p = claudePrices[claudeId];
    let inRate = p[0];
    let readRate = p[3];
    let outRate = p[4];
    if (claudeId === 'claude-haiku-5-5' && inputTokens + cacheReadTokens > 100000) {
      inRate = 0.5;
      readRate = 0.05;
      outRate = 2.5;
    }
    return (inputTokens * inRate + cacheReadTokens * readRate + outputTokens * outRate) / 1e6;
  }

  let rates = null;
  if (raw.includes('orchestrator')) {
    rates = inExecPhase ? [1.5, 0.075, 7.5] : [2.0, 0.1, 10.0];
  } else if (raw.includes('argon') || raw.includes('carbon')) {
    rates = [2.0, 0.1, 10.0];
  } else if (raw.includes('hydrogen')) {
    rates = [1.5, 0.075, 7.5];
  } else if (/3\.[678][-\s]flash/.test(raw)) {
    rates = [0.75, 0.075, 3.75];
  } else if (/3\.5[-\s]flash[-\s]lite/.test(raw)) {
    rates = [0.3, 0.03, 2.5];
  } else if (/3\.1[-\s]pro/.test(raw)) {
    rates = inputTokens + cacheReadTokens > 200000 ? [4.0, 0.4, 18.0] : [2.0, 0.2, 12.0];
  } else if (/3\.1[-\s]flash[-\s]lite/.test(raw)) {
    rates = [0.25, 0.025, 1.5];
  } else if (/2\.5[-\s]pro/.test(raw)) {
    rates = [1.25, 0.125, 10.0];
  } else if (/2\.5[-\s]flash/.test(raw)) {
    rates = [0.3, 0.03, 2.5];
  }

  if (!rates) return null;
  return (inputTokens * rates[0] + cacheReadTokens * rates[1] + outputTokens * rates[2]) / 1e6;
}

// Ponytail's board.ts modelName(m) splits on "-" and drops segments >= 3 chars,
// so returned strings must NEVER contain ASCII "-" hyphens.
function formatBoardModel(model) {
  const raw = String(model || '').trim();
  const s = raw.toLowerCase();
  if (!s || s === 'auto' || s === 'none') return 'Agy';

  if (s.includes('orchestrator')) {
    return s.includes('argon') ? 'Agy · Orchestrator (Argon)' : 'Agy · Orchestrator (Carbon)';
  }
  if (s.includes('gemini-4-argon') || s.includes('gemini 4 argon')) return 'Agy · Gemini 4 Argon';
  if (s.includes('gemini-4-carbon') || s.includes('gemini 4 carbon')) return 'Agy · Gemini 4 Carbon';
  if (s.includes('gemini-4-hydrogen') || s.includes('gemini 4 hydrogen')) return 'Agy · Gemini 4 Hydrogen';
  if (/3\.8[-\s]flash/.test(s)) return 'Agy · Gemini 3.8 Flash';
  if (/3\.7[-\s]flash/.test(s)) return 'Agy · Gemini 3.7 Flash';
  if (/3\.6[-\s]flash/.test(s)) return 'Agy · Gemini 3.6 Flash';
  if (/3\.5[-\s]flash[-\s]lite/.test(s)) return 'Agy · Gemini 3.5 Flash Lite';
  if (/3\.1[-\s]flash[-\s]lite/.test(s)) return 'Agy · Gemini 3.1 Flash Lite';
  if (/3\.1[-\s]pro/.test(s)) return 'Agy · Gemini 3.1 Pro';
  if (/2\.5[-\s]pro/.test(s)) return 'Agy · Gemini 2.5 Pro';
  if (/2\.5[-\s]flash/.test(s)) return 'Agy · Gemini 2.5 Flash';
  if (s.includes('gpt-oss-120b') || s.includes('gpt oss 120b')) return 'Agy · GPT OSS 120B';

  if (s.includes('opus')) {
    const m = /opus[-\s]*(\d+(?:[.\s-]\d+)?)/i.exec(s);
    const ver = m ? ` ${m[1].replace(/[-\s]+/g, '.')}` : '';
    return `Agy · Opus${ver}`;
  }
  if (s.includes('sonnet')) {
    const m = /sonnet[-\s]*(\d+(?:[.\s-]\d+)?)/i.exec(s);
    const ver = m ? ` ${m[1].replace(/[-\s]+/g, '.')}` : '';
    return `Agy · Sonnet${ver}`;
  }
  if (s.includes('haiku')) {
    const m = /haiku[-\s]*(\d+(?:[.\s-]\d+)?)/i.exec(s);
    const ver = m ? ` ${m[1].replace(/[-\s]+/g, '.')}` : '';
    return `Agy · Haiku${ver}`;
  }

  const cleaned = raw
    .replace(/\s*\((?:High|Medium|Low|XHigh|Max)\)\s*$/i, '')
    .replace(/-(?:high|medium|low|xhigh|max)$/i, '')
    .replace(/-/g, ' ')
    .trim();
  return cleaned ? `Agy · ${cleaned}` : 'Agy';
}

function isSourceCodeFile(filePath, baseRoot = '') {
  if (typeof filePath !== 'string' || !filePath) return false;
  const norm = filePath.replace(/\\/g, '/');
  if (!CODE_EXT.test(norm) || SKIP_TEST_FILE.test(norm)) return false;
  let rel = norm;
  if (typeof baseRoot === 'string' && baseRoot) {
    const cleanRoot = stripWorktreeSegment(baseRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    if (cleanRoot && (norm === cleanRoot || norm.startsWith(`${cleanRoot}/`))) {
      rel = norm.slice(cleanRoot.length + 1);
    }
  }
  return !SKIP_SOURCE_DIR.test(rel);
}

function testCountsFromOutput(output) {
  const num = re => {
    const m = re.exec(output);
    return m ? Number(m[1]) : undefined;
  };
  return {
    passed:
      num(/(\d+)\s+(?:passed|passing)\b/i) ??
      num(/\bpassed:\s*(\d+)/i) ??
      num(/(?:ℹ|#)\s*pass\s+(\d+)/i),
    failed:
      num(/(\d+)\s+(?:failed|failing)\b/i) ??
      num(/\bfailed:\s*(\d+)/i) ??
      num(/(?:ℹ|#)\s*fail\s+(\d+)/i),
  };
}

function testsLabelFromState(tests) {
  if (!tests || tests.state === 'none') return 'not run';
  if (tests.state === 'stale') return 'stale';
  if (tests.state === 'pass') return tests.passed !== undefined ? `${tests.passed} passed` : 'passed';
  if (tests.state === 'fail') return tests.failed !== undefined ? `${tests.failed} failed` : 'failed';
  return 'not run';
}

function applyTestOutput(testsState, outputText) {
  const codeMatch = /Command exited with code (\d+)/.exec(outputText);
  if (!codeMatch) return testsState;
  const exitCode = Number(codeMatch[1]);
  const counts = testCountsFromOutput(outputText);
  return {
    state: exitCode === 0 ? 'pass' : 'fail',
    passed: counts.passed,
    failed: counts.failed,
  };
}

function collectChildCandidates(transcriptPath, selfId, recordCache) {
  const invokeIds = new Set();
  const messageIds = new Set();
  let startedMs = NaN;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { invokeIds: [], messageIds: [], startedMs };
  }
  let pendingInvokeCount = 0;
  streamTranscriptRecords(
    transcriptPath,
    r => {
      const t = r.created_at ? Date.parse(r.created_at) : NaN;
      if (!Number.isFinite(startedMs) && Number.isFinite(t)) startedMs = t;
      if (r.type === 'PLANNER_RESPONSE') {
        const tcs = Array.isArray(r.tool_calls) ? r.tool_calls : [];
        pendingInvokeCount = tcs.filter(tc => tc && tc.name === 'invoke_subagent').length;
        for (const tc of tcs) {
          if (tc && tc.name === 'send_message' && tc.args && tc.args.Recipient) {
            const rec = String(unwrapArg(tc.args.Recipient) || '');
            for (const u of rec.match(UUID_RE) || []) {
              if (u !== selfId) messageIds.add(u);
            }
          }
        }
        return;
      }
      if (r.type === 'GENERIC' && pendingInvokeCount > 0) {
        const c = String(r.content || '');
        if (c.includes('conversationId') || c.includes('conversation://') || c.includes('Subagent')) {
          const uuids = (c.match(UUID_RE) || []).filter(u => u !== selfId);
          for (const u of uuids) invokeIds.add(u);
          if (uuids.length > 0) pendingInvokeCount--;
        }
      }
    },
    recordCache,
  );
  return { invokeIds: [...invokeIds], messageIds: [...messageIds], startedMs };
}

function isReverseParentTarget(selfId, selfStartedMs, targetId, targetInfo) {
  if (!targetInfo) return true;
  if (Array.isArray(targetInfo.invokeIds) && targetInfo.invokeIds.includes(selfId)) return true;
  if (Number.isFinite(selfStartedMs) && Number.isFinite(targetInfo.startedMs) && targetInfo.startedMs < selfStartedMs) {
    return true;
  }
  return false;
}

function discoverChildIds(transcriptPath, selfId, recordCache) {
  const selfInfo = collectChildCandidates(transcriptPath, selfId, recordCache);
  const children = new Set(selfInfo.invokeIds);
  if (selfInfo.messageIds.length > 0 && transcriptPath) {
    const brainDir = path.dirname(path.dirname(path.dirname(path.dirname(transcriptPath))));
    for (const cid of selfInfo.messageIds) {
      if (children.has(cid)) continue;
      const targetPath = resolveBestTranscriptPath(path.join(brainDir, cid, '.system_generated', 'logs', 'transcript.jsonl'));
      if (!targetPath) continue;
      const targetInfo = collectChildCandidates(targetPath, cid, recordCache);
      if (!isReverseParentTarget(selfId, selfInfo.startedMs, cid, targetInfo)) {
        children.add(cid);
      }
    }
  }
  return [...children];
}

function modelAtTime(timeline, ts, fallbackModel) {
  let picked = timeline[0] ? timeline[0].model : fallbackModel;
  if (!Number.isFinite(ts)) return picked || fallbackModel;
  for (const entry of timeline) {
    if (!Number.isFinite(entry.t) || entry.t <= ts) picked = entry.model;
    else break;
  }
  return picked;
}

function updatePhaseFromTools(toolCalls, inExec) {
  let next = inExec;
  for (const tc of toolCalls) {
    if (!tc || !tc.name) continue;
    if (tc.name === 'exit_plan_mode') next = true;
    else if (tc.name === 'enter_plan_mode') next = false;
  }
  return next;
}

function parseAgyTranscript(transcriptPath, meta = {}, childTranscriptPaths = [], options = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const gitCache = options.gitCache || new Map();
  const projectCache = options.projectCache || new Map();
  const ponytailDir = options.ponytailDir;
  const allowTemp = Boolean(options.allowTempWorkspaces || process.env.PONYTAIL_AGY_ALLOW_TEMP === '1');
  const hasExplicitCwd = Boolean(meta.cwd && !isIgnoredWorkspacePath(meta.cwd, allowTemp));
  const recordCache = options.recordCache;

  const records = [];
  const rootCounts = new Map();
  const cmdFallbackCounts = new Map();

  let currentModel = meta.modelName && !['auto', 'none'].includes(String(meta.modelName).trim().toLowerCase())
    ? String(meta.modelName).trim()
    : '';
  const modelTimeline = [{ t: Number.NEGATIVE_INFINITY, model: currentModel }];
  let inExecPhase = false;
  const modelReplyCounts = {};

  let tokensTotal = 0;
  let tokensOutput = 0;
  let totalCost = 0;
  let anyUnpriced = false;
  let hasReply = false;
  let hasHuman = false;
  let firstHumanName = '';
  const metaCustomLabel =
    typeof meta.customLabel === 'string' ? meta.customLabel.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  let startedMs = NaN;
  let level = defaultPonytailLevel();

  const billStep = (rec, model, inExec, trackDominant) => {
    const inp = rec.input_tokens || 0;
    const cr = rec.cache_read_tokens || 0;
    const out = rec.output_tokens || 0;
    if (inp + cr + out <= 0) return;
    tokensTotal += inp + cr + out;
    tokensOutput += out;
    if (trackDominant && model) {
      modelReplyCounts[model] = (modelReplyCounts[model] || 0) + 1;
    }
    const c = estimateStepCost(model, inExec, inp, cr, out, ponytailDir);
    if (c === null) anyUnpriced = true;
    else totalCost += c;
  };

  let tests = { state: 'none' };
  const pendingRunCmds = [];
  const asyncTestTasks = new Map();

  const scorePath = (rawPath, weight, targetMap) => {
    if (hasExplicitCwd || typeof rawPath !== 'string') return;
    if (isIgnoredWorkspacePath(rawPath, allowTemp)) return;
    const gRoot = resolveGitRoot(rawPath, gitCache);
    if (gRoot) {
      targetMap.set(gRoot, (targetMap.get(gRoot) || 0) + weight);
      return;
    }
    try {
      let dir = rawPath;
      while (dir && path.dirname(dir) !== dir && !fs.existsSync(dir)) dir = path.dirname(dir);
      if (!dir || isIgnoredWorkspacePath(dir, allowTemp)) return;
      if (fs.statSync(dir).isFile()) dir = path.dirname(dir);
      if (isIgnoredWorkspacePath(dir, allowTemp)) return;
      targetMap.set(dir, (targetMap.get(dir) || 0) + weight);
    } catch {}
  };

  const consumeAsyncCompletions = text => {
    const re = /Task id "([^"]+)" finished with result:\n([\s\S]*?)(?=\nTask id "|\n<\/SYSTEM_MESSAGE>|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (asyncTestTasks.has(m[1])) {
        tests = applyTestOutput(tests, m[2]);
        asyncTestTasks.delete(m[1]);
      }
    }
  };

  streamTranscriptRecords(
    transcriptPath,
    r => {
      const t = r.created_at ? Date.parse(r.created_at) : NaN;
    if (!Number.isFinite(startedMs) && Number.isFinite(t)) startedMs = t;

    const isHuman = r.source === 'USER_EXPLICIT' && r.type === 'USER_INPUT';
    if (isHuman) {
      hasHuman = true;
      inExecPhase = false;
      const content = String(r.content || '');
      const switched = detectModelChange(content);
      if (switched) {
        currentModel = switched;
        modelTimeline.push({ t: Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY, model: currentModel });
      }
      if (!firstHumanName) firstHumanName = extractPromptTitle(content);

      const promptLower = extractRawPromptText(content).toLowerCase();
      const lvlMatch = /^[/@$]ponytail(?::ponytail)?\s+(lite|full|ultra|off)\b/.exec(promptLower);
      if (lvlMatch) level = lvlMatch[1];
      else if (/\b(?:stop ponytail|normal mode)\b/.test(promptLower)) level = 'off';
    } else if (r.type === 'SYSTEM_MESSAGE') {
      const content = String(r.content || '');
      if (content.includes('[plan review]')) inExecPhase = false;
      consumeAsyncCompletions(content);
    }

    if (r.type === 'PLANNER_RESPONSE' || r.type === 'CHECKPOINT') {
      if (r.type === 'PLANNER_RESPONSE') hasReply = true;
      billStep(r, currentModel, inExecPhase, true);

      const tcs = Array.isArray(r.tool_calls) ? r.tool_calls : [];
      inExecPhase = updatePhaseFromTools(tcs, inExecPhase);
      for (const tc of tcs) {
        if (!tc || !tc.name || tc.name === 'exit_plan_mode' || tc.name === 'enter_plan_mode') continue;
        const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
        if (tc.name === 'run_command') {
          const cmd = String(unwrapArg(args.CommandLine) || '');
          if (!hasExplicitCwd) {
            const cwdArg = unwrapArg(args.Cwd);
            if (cwdArg) scorePath(String(cwdArg), 1, cmdFallbackCounts);
            for (const cp of extractCommandPaths(cmd)) scorePath(cp, 1, cmdFallbackCounts);
          }
          pendingRunCmds.push({ isTest: TEST_CMD.test(cmd), cmd });
        } else {
          if (!hasExplicitCwd) {
            const weight = tc.name === 'edit_file' || tc.name === 'write_file' ? 5 : 1;
            for (const key of ['Path', 'SearchPath', 'DirectoryPath', 'Cwd']) {
              if (args[key] !== undefined) {
                const val = String(unwrapArg(args[key]) || '');
                scorePath(val, weight, rootCounts);
              }
            }
          }
          if (tc.name === 'edit_file' || tc.name === 'write_file') {
            const target = String(unwrapArg(args.Path) || '');
            if (tests.state === 'pass' || tests.state === 'fail') {
              const explicitBase =
                meta.cwd && !isIgnoredWorkspacePath(meta.cwd, allowTemp)
                  ? resolveGitRoot(meta.cwd, gitCache) || stripWorktreeSegment(meta.cwd)
                  : '';
              const baseRoot = explicitBase || resolveGitRoot(target, gitCache) || '';
              if (isSourceCodeFile(target, baseRoot)) {
                tests = { state: 'stale' };
              }
            }
          }
        }
      }
    } else if (r.type === 'GENERIC') {
      const content = String(r.content || '');
      const bg = /Tool is running as a background task with task id:\s*([^\s]+)\nTask Description:\s*([^\n]+)/.exec(content);
      if (bg) {
        const entry = pendingRunCmds.shift();
        if (entry?.isTest || TEST_CMD.test(bg[2])) {
          asyncTestTasks.set(bg[1].trim(), entry?.cmd || bg[2]);
        }
      } else if (/Command exited with code \d+/.test(content)) {
        const entry = pendingRunCmds.shift();
        if (entry?.isTest) {
          tests = applyTestOutput(tests, content);
        }
      }
      if (content.includes('Task id "')) {
        consumeAsyncCompletions(content);
      }
    }

    records.push({
      type: r.type,
      source: r.source,
      t,
      toolCalls: Array.isArray(r.tool_calls) ? r.tool_calls.map(tc => tc && tc.name) : [],
    });
  }, recordCache);

  if (!hasHuman || !hasReply || !Number.isFinite(startedMs)) return null;

  // Include child subagent transcripts in token and estimated cost totals.
  for (const childPath of childTranscriptPaths || []) {
    if (!childPath || !fs.existsSync(childPath)) continue;
    let subModel;
    let subExec = false;
    streamTranscriptRecords(
      childPath,
      sr => {
      const st = sr.created_at ? Date.parse(sr.created_at) : NaN;
      if (subModel === undefined && Number.isFinite(st)) {
        subModel = modelAtTime(modelTimeline, st, currentModel);
      }
      if (sr.type === 'USER_INPUT') {
        subExec = false;
        const switched = detectModelChange(String(sr.content || ''));
        if (switched) subModel = switched;
      } else if (sr.type === 'SYSTEM_MESSAGE' && String(sr.content || '').includes('[plan review]')) {
        subExec = false;
      }
      if (sr.type === 'PLANNER_RESPONSE' || sr.type === 'CHECKPOINT') {
        if (subModel === undefined) subModel = currentModel;
        billStep(sr, subModel, subExec, false);
        const tcs = Array.isArray(sr.tool_calls) ? sr.tool_calls : [];
        subExec = updatePhaseFromTools(tcs, subExec);
      }
    },
    recordCache,
  );
  }

  // Compute turns & agent active time (excluding ask_question wait intervals and gaps > IDLE_MS).
  const userIdx = records
    .map((r, i) => (r.source === 'USER_EXPLICIT' && r.type === 'USER_INPUT' ? i : -1))
    .filter(i => i >= 0);

  let turns = 0;
  let agentMs = 0;
  for (let k = 0; k < userIdx.length; k++) {
    const end = k + 1 < userIdx.length ? userIdx[k + 1] : records.length;
    const slice = records.slice(userIdx[k], end);
    if (!slice.some(r => r.type === 'PLANNER_RESPONSE')) continue;
    turns++;
    let prev = slice[0].t;
    let waitingOnUser = false;
    for (let j = 1; j < slice.length; j++) {
      const step = slice[j];
      if (!Number.isFinite(step.t)) continue;
      if (!waitingOnUser && Number.isFinite(prev) && step.t > prev && step.t - prev <= IDLE_MS) {
        agentMs += step.t - prev;
      }
      prev = Number.isFinite(prev) ? Math.max(prev, step.t) : step.t;
      if (step.type === 'PLANNER_RESPONSE') {
        waitingOnUser = step.toolCalls.includes('ask_question');
      } else if (step.type === 'GENERIC') {
        waitingOnUser = false;
      }
    }
  }
  if (turns === 0) return null;

  // Determine project name: explicit meta.cwd > file tool root > command path root > fallback.
  let project = '';
  if (hasExplicitCwd) {
    project = projectOf(meta.cwd, projectCache, gitCache);
  } else {
    const pickBest = map => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const bestDir = pickBest(rootCounts) || pickBest(cmdFallbackCounts);
    project = bestDir ? projectOf(bestDir, projectCache, gitCache) : 'antigravity';
  }

  const dominantModel =
    Object.keys(modelReplyCounts).sort((a, b) => modelReplyCounts[b] - modelReplyCounts[a])[0] || currentModel;
  const costUsd = anyUnpriced || !dominantModel || totalCost <= 0 ? null : totalCost;

  return {
    startedMs,
    project,
    name: metaCustomLabel || firstHumanName,
    costUsd,
    turns,
    agentMs,
    tokensTotal,
    tokensOutput,
    tests: testsLabelFromState(tests),
    level,
    model: formatBoardModel(dominantModel),
  };
}

const two = n => String(n).padStart(2, '0');
function formatStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function formatCsvRow(conversationId, stats) {
  const key = `${conversationId.slice(0, 8)}-${stats.startedMs}`;
  const cols = [
    key,
    formatStamp(stats.startedMs),
    stats.project,
    stats.name,
    stats.costUsd === null ? '' : stats.costUsd.toFixed(2),
    stats.turns,
    (stats.agentMs / 60000).toFixed(1),
    stats.tokensTotal,
    stats.tokensOutput,
    '',
    '',
    '',
    '',
    stats.tests,
    stats.level,
    stats.model,
  ];
  return cols.map(csvField).join(',');
}

// Same RFC-4180 CSV parser / tasksFrom as Ponytail's board.ts (fallback only if board.ts is absent).
function parseCsvLocal(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

function tasksFromLocal(text) {
  const [head, ...rows] = parseCsvLocal(text);
  if (!head || !head.includes('key')) return [];
  const at = (r, col) => r[head.indexOf(col)] ?? '';
  const num = (r, col) => Number(at(r, col)) || 0;
  return rows.map(r => ({
    started: at(r, 'started'),
    project: at(r, 'project'),
    name: at(r, 'name'),
    cost: num(r, 'cost_usd'),
    turns: num(r, 'turns'),
    agentMinutes: num(r, 'agent_minutes'),
    tokens: num(r, 'tokens_total'),
    reuse: at(r, 'reuse_pct') === '' ? null : num(r, 'reuse_pct'),
    tests: at(r, 'tests'),
    level: at(r, 'level'),
    model: at(r, 'model'),
  }));
}

function keyPrefix(key) {
  const s = String(key || '');
  const idx = s.lastIndexOf('-');
  return idx >= 0 ? s.slice(0, idx + 1) : '';
}

function upsertCsvRows(ledgerDir, entries) {
  return withLedgerLock(ledgerDir, () => {
    const byFile = new Map();
    const targetFileByPrefix = new Map();

    for (const entry of entries) {
      const file = path.join(ledgerDir, `${entry.project.replace(/[^\w.-]/g, '_')}.csv`);
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(entry);
      targetFileByPrefix.set(`${entry.conversationId.slice(0, 8)}-`, file);
    }

    let updated = 0;
    for (const [file, items] of byFile) {
      let existing = '';
      try {
        existing = fs.readFileSync(file, 'utf8');
      } catch {}
      const existingRows = parseCsvLocal(existing).filter((cols, idx) => !(idx === 0 && cols[0] === 'key'));
      const prefixes = new Set(items.map(it => `${it.conversationId.slice(0, 8)}-`));
      const priorByPrefix = new Map();
      const keptLines = [];
      for (const cols of existingRows) {
        const pref = keyPrefix(cols[0]);
        const line = cols.map(csvField).join(',');
        if (prefixes.has(pref)) {
          if (!priorByPrefix.has(pref)) priorByPrefix.set(pref, []);
          priorByPrefix.get(pref).push(line);
        } else {
          keptLines.push(line);
        }
      }
      const newLines = [];
      for (const it of items) {
        const pref = `${it.conversationId.slice(0, 8)}-`;
        const line = formatCsvRow(it.conversationId, it.stats);
        newLines.push(line);
        const prev = priorByPrefix.get(pref);
        if (!prev || prev.length !== 1 || prev[0] !== line) {
          updated++;
        }
      }
      const nextText = [CSV_HEADER, ...keptLines, ...newLines].join('\n') + '\n';
      if (nextText !== existing) {
        writeAtomic(file, nextText);
      }
    }

    // Remove stale rows for moved sessions across any sibling *.csv ledger.
    if (targetFileByPrefix.size > 0 && fs.existsSync(ledgerDir)) {
      let csvFiles = [];
      try {
        csvFiles = fs.readdirSync(ledgerDir).filter(f => f.endsWith('.csv'));
      } catch {}
      for (const fname of csvFiles) {
        const siblingPath = path.join(ledgerDir, fname);
        const siblingResolved = path.resolve(siblingPath);
        const dropHere = new Set();
        for (const [pref, destFile] of targetFileByPrefix) {
          if (path.resolve(destFile) !== siblingResolved) dropHere.add(pref);
        }
        if (dropHere.size === 0) continue;
        const existing = fs.readFileSync(siblingPath, 'utf8');
        const rows = parseCsvLocal(existing).filter((cols, idx) => !(idx === 0 && cols[0] === 'key'));
        const kept = rows.filter(cols => !dropHere.has(keyPrefix(cols[0])));
        if (kept.length !== rows.length) {
          if (kept.length === 0) {
            fs.rmSync(siblingPath, { force: true });
          } else {
            const text = [CSV_HEADER, ...kept.map(c => c.map(csvField).join(','))].join('\n') + '\n';
            writeAtomic(siblingPath, text);
          }
        }
      }
    }

    return updated;
  });
}

function loadPonytailBoardModule(ponytailDir) {
  const { stripTypeScriptTypes } = require('module');
  if (typeof stripTypeScriptTypes !== 'function') {
    throw new Error('Node stripTypeScriptTypes unavailable');
  }
  const bandDir = path.join(ponytailDir, 'hooks', 'band');
  const boardPath = path.join(bandDir, 'board.ts');
  const logoPath = path.join(bandDir, 'logo.ts');
  if (!fs.existsSync(boardPath) || !fs.existsSync(logoPath)) {
    throw new Error(`Ponytail board sources missing under ${bandDir}`);
  }

  const compileTs = (tsPath, deps = {}) => {
    let js = stripTypeScriptTypes(fs.readFileSync(tsPath, 'utf8'));
    js = js
      .replace(/^import\s+\{\s*([^}]+)\s*\}\s+from\s+['"](\.\/\w+)['"]/gm, 'const { $1 } = __deps["$2"];')
      .replace(/^export\s+const\s+(\w+)/gm, 'const $1 = exports.$1')
      .replace(/^export\s+function\s+(\w+)/gm, 'exports.$1 = $1; function $1');
    const exports = {};
    vm.runInNewContext(js, {
      exports,
      __deps: deps,
      JSON,
      Math,
      Date,
      Number,
      String,
      Array,
      Object,
      RegExp,
      Set,
      Map,
      encodeURIComponent,
    });
    return exports;
  };

  const logo = compileTs(logoPath);
  return compileTs(boardPath, { './logo': logo });
}

const BOARD_DATA_RE = /(<script type="application\/json" id="board-data">)[\s\S]*?(<\/script>)/;

function serializeBoardPayload(tasks, now) {
  return JSON.stringify({ now, tasks })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Render a standalone HTML board when Ponytail's TypeScript board renderer is not installed. */
function renderStandaloneBoardHtml(payload) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ponytail Board (Antigravity)</title>
<style>
  :root{color-scheme:dark;--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--card:#161b22;--border:#30363d;--accent:#58a6ff}
  body{margin:0;padding:24px;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
  header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:16px}
  h1{margin:0;font-size:18px;font-weight:600}
  .meta{color:var(--muted);font-size:12px}
  .wrap{overflow-x:auto;background:var(--card);border:1px solid var(--border);border-radius:8px}
  table{width:100%;border-collapse:collapse;text-align:left}
  th,td{padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap}
  th{color:var(--muted);font-weight:500;font-size:12px}
  td.title{white-space:normal;min-width:220px}
  tr:last-child td{border-bottom:none}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .empty{padding:24px;color:var(--muted);text-align:center}
</style>
</head>
<body>
<header>
  <h1>Ponytail Board</h1>
  <span class="meta" id="board-summary"></span>
</header>
<div class="wrap">
  <table>
    <thead>
      <tr><th>Started</th><th>Project</th><th>Task</th><th class="num">Cost</th><th class="num">Turns</th><th class="num">Min</th><th class="num">Tokens</th><th>Tests</th><th>Level</th><th>Model</th></tr>
    </thead>
    <tbody id="board-rows"></tbody>
  </table>
</div>
<script type="application/json" id="board-data">${payload}</script>
<script>
(function(){
  var data = JSON.parse(document.getElementById('board-data').textContent || '{}');
  var tasks = Array.isArray(data.tasks) ? data.tasks.slice() : [];
  tasks.sort(function(a,b){ return String(b.started || '').localeCompare(String(a.started || '')); });
  var totalCost = tasks.reduce(function(s,t){ return s + (Number(t.cost) || 0); }, 0);
  document.getElementById('board-summary').textContent = tasks.length + ' task(s) · $' + totalCost.toFixed(2);
  var tbody = document.getElementById('board-rows');
  if (!tasks.length) {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.colSpan = 10;
    td.className = 'empty';
    td.textContent = 'No sessions recorded yet.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  tasks.forEach(function(t){
    var tr = document.createElement('tr');
    var cells = [
      [t.started || '', ''],
      [t.project || '', ''],
      [t.name || '', 'title'],
      [t.cost ? '$' + Number(t.cost).toFixed(2) : '-', 'num'],
      [String(t.turns || 0), 'num'],
      [Number(t.agentMinutes || 0).toFixed(1), 'num'],
      [Number(t.tokens || 0).toLocaleString(), 'num'],
      [t.tests || '', ''],
      [t.level || '', ''],
      [t.model || '', '']
    ];
    cells.forEach(function(pair){
      var td = document.createElement('td');
      if (pair[1]) td.className = pair[1];
      td.textContent = pair[0];
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
})();
</script>
</body>
</html>
`;
}

function rebuildBoardHtml(ledgerDir, ponytailDir = defaultPonytailDir()) {
  return withLedgerLock(ledgerDir, () => {
    const csvFiles = fs.readdirSync(ledgerDir).filter(f => f.endsWith('.csv')).sort();
    const boardFile = path.join(ledgerDir, 'board.html');

    try {
      const board = loadPonytailBoardModule(ponytailDir);
      const tasks = csvFiles.flatMap(f => board.tasksFrom(fs.readFileSync(path.join(ledgerDir, f), 'utf8')));
      const html = board.boardHtml(tasks, Date.now());
      writeAtomic(boardFile, html);
      return { boardFile, totalTasks: tasks.length, renderer: 'ponytail' };
    } catch {
      const tasks = csvFiles.flatMap(f => tasksFromLocal(fs.readFileSync(path.join(ledgerDir, f), 'utf8')));
      const payload = serializeBoardPayload(tasks, Date.now());
      if (fs.existsSync(boardFile)) {
        const current = fs.readFileSync(boardFile, 'utf8');
        if (BOARD_DATA_RE.test(current)) {
          const updated = current.replace(BOARD_DATA_RE, (_, open, close) => `${open}${payload}${close}`);
          writeAtomic(boardFile, updated);
          return { boardFile, totalTasks: tasks.length, renderer: 'fallback' };
        }
      }
      writeAtomic(boardFile, renderStandaloneBoardHtml(payload));
      return { boardFile, totalTasks: tasks.length, renderer: 'standalone' };
    }
  });
}

function resolveBestTranscriptPath(candidatePath) {
  if (!candidatePath) return null;
  if (path.basename(candidatePath) === 'transcript.jsonl') {
    const full = path.join(path.dirname(candidatePath), 'transcript_full.jsonl');
    if (fs.existsSync(full)) return full;
  }
  return fs.existsSync(candidatePath) ? candidatePath : null;
}

function collectDescendants(rootId, getChildren) {
  const out = [];
  const seen = new Set([rootId]);
  const queue = [...(getChildren(rootId) || [])];
  while (queue.length > 0) {
    const cid = queue.shift();
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    out.push(cid);
    for (const gid of getChildren(cid) || []) {
      if (!seen.has(gid)) queue.push(gid);
    }
  }
  return out;
}

function importAllBrains(options = {}) {
  const ledgerDir = options.ledgerDir || defaultLedgerDir();
  const ponytailDir = options.ponytailDir || defaultPonytailDir();
  const brainDirs = options.brainDirs || defaultBrainDirs();
  const rawProjects = [
    ...(Array.isArray(options.projects) ? options.projects : []),
    ...(options.project ? [options.project] : []),
  ]
    .map(p => String(p || '').trim().toLowerCase())
    .filter(Boolean);
  const projectFilter = rawProjects.length > 0 ? new Set(rawProjects) : null;

  const metaCachePath = path.join(ledgerDir, '.agy-sessions.json');
  const sessionMeta = readJsonSafe(metaCachePath, {});
  const sessions = new Map();

  for (const brainDir of brainDirs) {
    let ids = [];
    try {
      ids = fs.readdirSync(brainDir);
    } catch {
      continue;
    }
    for (const id of ids) {
      const logsDir = path.join(brainDir, id, '.system_generated', 'logs');
      const full = path.join(logsDir, 'transcript_full.jsonl');
      const compact = path.join(logsDir, 'transcript.jsonl');
      const transcriptPath = fs.existsSync(full) ? full : fs.existsSync(compact) ? compact : null;
      if (!transcriptPath) continue;
      if (!sessions.has(id)) {
        sessions.set(id, { id, brainDir, transcriptPath, mtimeMs: fs.statSync(transcriptPath).mtimeMs });
      } else {
        const prev = sessions.get(id);
        const mtimeMs = fs.statSync(transcriptPath).mtimeMs;
        if (mtimeMs > prev.mtimeMs) {
          sessions.set(id, { id, brainDir, transcriptPath, mtimeMs });
        }
      }
    }
  }

  // Build parent -> child subagent graph so child conversations roll up into their parent.
  const childToParent = new Map();
  const parentToChildren = new Map();
  const linksById = new Map();
  const recordCache = new Map();
  for (const [id, info] of sessions) {
    linksById.set(id, collectChildCandidates(info.transcriptPath, id, recordCache));
  }
  const createsCycle = (parentId, childId) => {
    let cur = parentId;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      if (cur === childId) return true;
      seen.add(cur);
      cur = childToParent.get(cur);
    }
    return false;
  };
  const linkEdge = (parentId, childId) => {
    if (!sessions.has(childId) || childId === parentId) return;
    if (childToParent.has(childId) || createsCycle(parentId, childId)) return;
    if (!parentToChildren.has(parentId)) parentToChildren.set(parentId, []);
    parentToChildren.get(parentId).push(childId);
    childToParent.set(childId, parentId);
  };
  for (const [id, links] of linksById) {
    for (const cid of links.invokeIds) linkEdge(id, cid);
  }
  for (const [id, links] of linksById) {
    for (const cid of links.messageIds) {
      const target = linksById.get(cid);
      if (!isReverseParentTarget(id, links.startedMs, cid, target)) {
        linkEdge(id, cid);
      }
    }
  }

  const gitCache = new Map();
  const projectCache = new Map();
  const entries = [];
  let found = 0;

  for (const [id, info] of sessions) {
    if (childToParent.has(id)) continue;
    const childPaths = collectDescendants(id, pid => parentToChildren.get(pid)).map(
      cid => sessions.get(cid).transcriptPath,
    );
    const stats = parseAgyTranscript(info.transcriptPath, sessionMeta[id] || {}, childPaths, {
      gitCache,
      projectCache,
      ponytailDir,
      allowTempWorkspaces: options.allowTempWorkspaces,
      recordCache,
    });
    if (!stats) continue;
    found++;
    entries.push({ conversationId: id, project: stats.project, stats });
  }

  const targetEntries = projectFilter
    ? entries.filter(e => projectFilter.has(e.project.toLowerCase()))
    : entries;
  found = targetEntries.length;

  const { updated, boardResult } = withLedgerLock(ledgerDir, () => {
    const rowsUpdated = targetEntries.length > 0 ? upsertCsvRows(ledgerDir, targetEntries) : 0;
    const htmlRes = rebuildBoardHtml(ledgerDir, ponytailDir);
    return { updated: rowsUpdated, boardResult: htmlRes };
  });
  return {
    sessionsFound: found,
    rowsUpdated: updated,
    totalBoardTasks: boardResult.totalTasks,
    boardFile: boardResult.boardFile,
  };
}

function handleHookPayload(payload, options = {}) {
  const ledgerDir = options.ledgerDir || defaultLedgerDir();
  const ponytailDir = options.ponytailDir || defaultPonytailDir();
  const event = String(payload?.hookEventName || '');
  const id = String(payload?.conversationId || '').trim();
  const cwd = (Array.isArray(payload?.workspacePaths) && payload.workspacePaths[0]) || payload?.cwd || '';
  const modelName = String(payload?.modelName || '').trim();
  const rawLabel = String(payload?.customLabel || payload?.title || '').replace(/\s+/g, ' ').trim();
  const customLabel = rawLabel ? rawLabel.slice(0, 120) : '';

  const allowTemp = Boolean(options.allowTempWorkspaces || process.env.PONYTAIL_AGY_ALLOW_TEMP === '1');
  const validCwd = cwd && !isIgnoredWorkspacePath(cwd, allowTemp) ? cwd : '';

  const metaCachePath = path.join(ledgerDir, '.agy-sessions.json');
  const sessionMetaForStop = id
    ? withLedgerLock(ledgerDir, () => {
        const cache = readJsonSafe(metaCachePath, {});
        const prev = cache[id] || {};
        const prevValidCwd = prev.cwd && !isIgnoredWorkspacePath(prev.cwd, allowTemp) ? prev.cwd : '';
        const savedLabel = customLabel || (typeof prev.customLabel === 'string' ? prev.customLabel : '');
        const nextMeta = {
          cwd: validCwd || prevValidCwd,
          modelName: modelName && !['auto', 'none'].includes(modelName.toLowerCase()) ? modelName : prev.modelName || '',
          ...(savedLabel ? { customLabel: savedLabel } : {}),
          updatedAt: Date.now(),
        };
        cache[id] = nextMeta;
        writeAtomic(metaCachePath, JSON.stringify(cache, null, 2));
        return nextMeta;
      })
    : {};

  if (event === 'Stop' && id && payload?.transcriptPath) {
    const tPath = resolveBestTranscriptPath(String(payload.transcriptPath));
    if (tPath) {
      const brainDir = path.dirname(path.dirname(path.dirname(path.dirname(tPath))));
      const recordCache = new Map();
      const childPaths = collectDescendants(id, pid => {
        const p = pid === id
          ? tPath
          : resolveBestTranscriptPath(path.join(brainDir, pid, '.system_generated', 'logs', 'transcript.jsonl'));
        return p ? discoverChildIds(p, pid, recordCache) : [];
      })
        .map(cid => resolveBestTranscriptPath(path.join(brainDir, cid, '.system_generated', 'logs', 'transcript.jsonl')))
        .filter(Boolean);
      const stats = parseAgyTranscript(tPath, sessionMetaForStop, childPaths, {
        ponytailDir,
        allowTempWorkspaces: options.allowTempWorkspaces,
        recordCache,
      });
      if (stats) {
        withLedgerLock(ledgerDir, () => {
          upsertCsvRows(ledgerDir, [{ conversationId: id, project: stats.project, stats }]);
          rebuildBoardHtml(ledgerDir, ponytailDir);
        });
      }
    }
  }

  return event === 'Stop' ? { decision: 'allow' } : {};
}

function parseCliArgs(argv) {
  const opts = {
    importMode: false,
    json: false,
    brainDirs: [],
    projects: [],
    ledgerDir: undefined,
    ponytailDir: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--import') opts.importMode = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--brain-dir' && argv[i + 1]) opts.brainDirs.push(argv[++i]);
    else if (a === '--project' && argv[i + 1]) opts.projects.push(argv[++i]);
    else if (a === '--ledger-dir' && argv[i + 1]) opts.ledgerDir = argv[++i];
    else if (a === '--ponytail-dir' && argv[i + 1]) opts.ponytailDir = argv[++i];
  }
  if (opts.brainDirs.length === 0) delete opts.brainDirs;
  if (opts.projects.length === 0) delete opts.projects;
  return opts;
}

if (require.main === module) {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.importMode) {
    const res = importAllBrains(cli);
    if (cli.json) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
    } else {
      process.stdout.write(
        `ponytail-agy-band import: ${res.sessionsFound} agy session(s) parsed, ${res.rowsUpdated} row(s) updated, ${res.totalBoardTasks} total task(s) on ${res.boardFile}\n`,
      );
    }
    process.exit(0);
  }

  let input = '';
  let done = false;
  let hookEventName = '';
  const finish = () => {
    if (done) return;
    done = true;
    let out = {};
    try {
      const payload = JSON.parse(input.replace(/^\uFEFF/, '') || '{}');
      hookEventName = String(payload?.hookEventName || '');
      out = handleHookPayload(payload);
    } catch {
      out = hookEventName === 'Stop' ? { decision: 'allow' } : {};
    }
    fs.writeSync(1, `${JSON.stringify(out)}\n`);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    finish();
    process.exit(0);
  });
  process.stdin.on('error', () => {
    finish();
    process.exit(0);
  });
  setTimeout(() => {
    finish();
    process.exit(0);
  }, STDIN_TIMEOUT_MS);
}

module.exports = {
  CSV_HEADER,
  discoverChildIds,
  estimateStepCost,
  formatBoardModel,
  handleHookPayload,
  importAllBrains,
  parseAgyTranscript,
  projectOf,
  rebuildBoardHtml,
  streamJsonl,
  testsLabelFromState,
  upsertCsvRows,
};
