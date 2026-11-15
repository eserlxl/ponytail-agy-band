// SPDX-FileCopyrightText: 2026 Eser KUBALI
// SPDX-License-Identifier: GPL-3.0-or-later

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SYNC_SCRIPT = path.join(PLUGIN_ROOT, 'hooks', 'sync-band.js');

const {
  CSV_HEADER,
  collectBrainSessions,
  estimateStepCost,
  formatBoardModel,
  handleHookPayload,
  importAllBrains,
  inspectBandStatus,
  parseAgyTranscript,
  rebuildBoardHtml,
  streamJsonl,
  sweepStaleTempFiles,
  upsertCsvRows,
  withLedgerLock,
} = require(SYNC_SCRIPT);

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function makePonytailFixture(baseDir) {
  const dir = path.join(baseDir, 'ponytail-fixture');
  const bandDir = path.join(dir, 'hooks', 'band');
  fs.mkdirSync(bandDir, { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'hooks', 'ponytail-band-import.js'),
    `exports.PRICES = {
  'claude-opus-5-5': [4, 5, 8, 0.2, 20],
  'claude-sonnet-5-5': [2, 2.5, 4, 0.1, 10],
};
`,
    'utf8',
  );

  fs.writeFileSync(
    path.join(bandDir, 'logo.ts'),
    `export const LOGO_VIEWBOX: string = '0 0 24 24';
export const LOGO_PATHS: string[] = ['M0 0h24v24H0z'];
`,
    'utf8',
  );

  fs.writeFileSync(
    path.join(bandDir, 'board.ts'),
    `import { LOGO_VIEWBOX, LOGO_PATHS } from './logo';

export function parseCsv(text: string): string[][] {
  const lines = text.trim().split('\\n').filter(Boolean);
  return lines.map(line => line.split(','));
}

export function tasksFrom(text: string): Record<string, unknown>[] {
  const rows = parseCsv(text);
  const [head, ...rest] = rows;
  if (!head || !head.includes('key')) return [];
  const at = (r: string[], col: string): string => r[head.indexOf(col)] ?? '';
  const num = (r: string[], col: string): number => Number(at(r, col)) || 0;
  return rest.map(r => ({
    started: at(r, 'started'),
    project: at(r, 'project'),
    name: at(r, 'name'),
    cost: num(r, 'cost_usd'),
    turns: num(r, 'turns'),
    agentMinutes: num(r, 'agent_minutes'),
    tokens: num(r, 'tokens_total'),
    tests: at(r, 'tests'),
    level: at(r, 'level'),
    model: at(r, 'model'),
  }));
}

export function boardHtml(tasks: Record<string, unknown>[], now: number): string {
  const payload = JSON.stringify({ now, tasks }).replace(/</g, '\\\\u003c');
  return '<!doctype html><html><body>' +
    '<svg viewBox="' + LOGO_VIEWBOX + '"><path d="' + LOGO_PATHS[0] + '"/></svg>' +
    '<script type="application/json" id="board-data">' + payload + '</script>' +
    '</body></html>';
}
`,
    'utf8',
  );

  return dir;
}

test('parses synthetic agy transcript with planner/exec tariffs, ask_question pause, tests, stale flip, and child subagent', t => {
  const tmp = makeTmpDir('pw-agy-parse-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);

  const repoDir = path.join(tmp, 'my-app');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  spawnSync('git', ['init', repoDir], { encoding: 'utf8' });
  const srcFile = path.join(repoDir, 'src', 'index.js');
  fs.writeFileSync(srcFile, 'console.log(1);\n', 'utf8');

  const parentId = '11111111-2222-3333-4444-555555555555';
  const childId = '99999999-aaaa-bbbb-cccc-dddddddddddd';

  const parentTranscript = path.join(tmp, 'brain', parentId, '.system_generated', 'logs', 'transcript_full.jsonl');
  const childTranscript = path.join(tmp, 'brain', childId, '.system_generated', 'logs', 'transcript_full.jsonl');

  // Cost math check:
  // Planner step: Orchestrator (Carbon) -> Carbon rates [2.0, 0.10, 10.0]
  //   1,000,000 input ($2.00) + 2,000,000 cache_read ($0.20) + 100,000 output ($1.00) = $3.20
  // Exec step: exit_plan_mode sets exec phase -> Hydrogen rates [1.5, 0.075, 7.5]
  //   1,000,000 input ($1.50) + 2,000,000 cache_read ($0.15) + 100,000 output ($0.75) = $2.40
  // Child subagent (inherits Orchestrator Carbon plan rates):
  //   500,000 input ($1.00) + 0 cache_read + 50,000 output ($0.50) = $1.50
  // Total expected cost = $7.10
  // Total expected tokens = (1M + 2M + 100k) * 2 + 550k = 6,750,000, output = 250,000
  writeJsonl(parentTranscript, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-15T10:00:00Z',
      content:
        '<USER_REQUEST>\nFix broken auth flow\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Orchestrator (Carbon). Do not mention this.\n</USER_SETTINGS_CHANGE>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:02:00Z',
      input_tokens: 1_000_000,
      cache_read_tokens: 2_000_000,
      output_tokens: 100_000,
      tool_calls: [{ name: 'ask_question', args: {} }],
    },
    // 4-hour human pause while ask_question waits for reply: must NOT be added to agentMs!
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-15T14:02:00Z',
      content: 'Answer: Proceed',
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T14:03:00Z',
      tool_calls: [{ name: 'exit_plan_mode', args: { plan: '"Do work"' } }],
    },
    {
      step_index: 4,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-15T14:03:05Z',
      content: 'Plan mode is off.',
    },
    {
      step_index: 5,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T14:05:00Z',
      input_tokens: 1_000_000,
      cache_read_tokens: 2_000_000,
      output_tokens: 100_000,
      tool_calls: [
        { name: 'edit_file', args: { Path: JSON.stringify(srcFile) } },
        { name: 'run_command', args: { CommandLine: '"node --test"' } },
      ],
    },
    {
      step_index: 6,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-15T14:05:10Z',
      content: 'Command exited with code 0.\n\nCommand output:\nℹ pass 12\nℹ fail 0\n',
    },
    {
      step_index: 7,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-15T14:10:00Z',
      content: '<USER_REQUEST>\n/ponytail ultra\n</USER_REQUEST>',
    },
    {
      step_index: 8,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T14:11:00Z',
      tool_calls: [{ name: 'invoke_subagent', args: {} }],
    },
    {
      step_index: 9,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-15T14:11:05Z',
      content: `Subagent launched: conversationId=${childId}`,
    },
  ]);

  writeJsonl(childTranscript, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-15T14:11:01Z',
      content: 'Subagent task',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T14:11:04Z',
      input_tokens: 500_000,
      cache_read_tokens: 0,
      output_tokens: 50_000,
      tool_calls: [],
    },
  ]);

  const stats = parseAgyTranscript(parentTranscript, {}, [childTranscript], { ponytailDir, allowTempWorkspaces: true });
  assert.ok(stats);
  assert.equal(stats.name, 'Fix broken auth flow');
  assert.equal(stats.project, 'my-app');
  assert.equal(stats.turns, 2);
  // Active time: 2m (10:00->10:02) + 1m (14:02->14:03) + 5s + 1m55s + 10s + 1m + 5s = 6m15s -> 6.3m (375,000 ms), NOT 246m!
  assert.equal(stats.agentMs, 375_000);
  assert.equal(stats.tokensTotal, 6_750_000);
  assert.equal(stats.tokensOutput, 250_000);
  assert.ok(Math.abs(stats.costUsd - 7.1) < 1e-6, `expected $7.10, got ${stats.costUsd}`);
  assert.equal(stats.tests, '12 passed');
  assert.equal(stats.level, 'ultra');
  assert.equal(stats.model, 'Agy · Orchestrator (Carbon)');
  assert.equal(stats.model.includes('-'), false);

  // If a subsequent edit touches a source file without rerunning tests, state becomes 'stale'.
  const staleTranscript = path.join(tmp, 'stale.jsonl');
  writeJsonl(staleTranscript, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-15T15:00:00Z',
      content: '<USER_REQUEST>\nVerify stale flip\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T15:01:00Z',
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"pytest"' } }],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-15T15:01:10Z',
      content: 'Command exited with code 0.\n\n5 passed in 0.2s\n',
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T15:02:00Z',
      tool_calls: [{ name: 'edit_file', args: { Path: JSON.stringify(srcFile) } }],
    },
  ]);
  const staleStats = parseAgyTranscript(staleTranscript, {}, [], { ponytailDir });
  assert.equal(staleStats.tests, 'stale');
});

test('unknown or auto model leaves costUsd null (empty cost_usd) and formats model as Agy', t => {
  const tmp = makeTmpDir('pw-agy-auto-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);

  const transcript = path.join(tmp, 'transcript.jsonl');
  writeJsonl(transcript, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-15T11:00:00Z',
      content: '<USER_REQUEST>\nExplain event loop\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T11:00:20Z',
      input_tokens: 10_000,
      cache_read_tokens: 5_000,
      output_tokens: 500,
      tool_calls: [],
    },
  ]);

  const stats = parseAgyTranscript(transcript, { modelName: 'auto' }, [], { ponytailDir });
  assert.ok(stats);
  assert.equal(stats.costUsd, null);
  assert.equal(stats.model, 'Agy');
  assert.equal(stats.project, 'antigravity');
  assert.equal(stats.tests, 'not run');
  assert.equal(estimateStepCost('auto', false, 1000, 0, 100, ponytailDir), null);
  assert.equal(formatBoardModel('gemini-3.8-flash-high'), 'Agy · Gemini 3.8 Flash');
  assert.equal(formatBoardModel('claude-opus-5-5-medium'), 'Agy · Opus 5.5');

  const dottedTranscript = path.join(tmp, 'dotted-model.jsonl');
  writeJsonl(dottedTranscript, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-15T11:30:00Z',
      content:
        '<USER_REQUEST>\nTest dotted model name\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). Do not mention this.\n</USER_SETTINGS_CHANGE>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T11:30:10Z',
      input_tokens: 1_000_000,
      cache_read_tokens: 0,
      output_tokens: 100_000,
      tool_calls: [],
    },
  ]);
  const dottedStats = parseAgyTranscript(dottedTranscript, {}, [], { ponytailDir });
  assert.equal(dottedStats.model, 'Agy · Gemini 3.8 Flash');
  assert.ok(Math.abs(dottedStats.costUsd - 1.125) < 1e-6);
});

test('upsertCsvRows preserves Claude Code rows, deduplicates agy rows, cleans antigravity fallback, and rebuildBoardHtml includes both', t => {
  const tmp = makeTmpDir('pw-agy-ledger-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);

  const ledgerDir = path.join(tmp, 'band');
  fs.mkdirSync(ledgerDir, { recursive: true });

  const claudeRow =
    'cc123456-1700000000000,2026-11-14 09:00,shop,Refactor billing,2.50,4,12.0,900000,12000,75,3,1,0,10 passed,full,claude-opus-5-5';
  fs.writeFileSync(path.join(ledgerDir, 'shop.csv'), `${CSV_HEADER}\n${claudeRow}\n`, 'utf8');

  const convId = 'abcdef12-0000-1111-2222-333344445555';
  const fallbackRow =
    'abcdef12-1763200000000,2026-11-15 10:00,antigravity,Old title,,1,1.0,1000,100,,,,,not run,full,Agy';
  fs.writeFileSync(path.join(ledgerDir, 'antigravity.csv'), `${CSV_HEADER}\n${fallbackRow}\n`, 'utf8');

  const stats = {
    startedMs: Date.parse('2026-11-15T10:00:00Z'),
    project: 'shop',
    name: 'Add checkout validation',
    costUsd: 1.25,
    turns: 3,
    agentMs: 300_000,
    tokensTotal: 450_000,
    tokensOutput: 9_000,
    tests: '24 passed',
    level: 'full',
    model: 'Agy · Orchestrator (Carbon)',
  };

  upsertCsvRows(ledgerDir, [{ conversationId: convId, project: 'shop', stats }]);
  // Second upsert for same conversation replaces row rather than duplicating it.
  upsertCsvRows(ledgerDir, [
    { conversationId: convId, project: 'shop', stats: { ...stats, turns: 4, costUsd: 1.5 } },
  ]);

  const shopCsv = fs.readFileSync(path.join(ledgerDir, 'shop.csv'), 'utf8');
  assert.ok(shopCsv.includes(claudeRow), 'Claude Code row must be preserved untouched');
  const lines = shopCsv.trim().split('\n');
  assert.equal(lines.length, 3, 'Header + 1 Claude row + 1 deduplicated Agy row');
  assert.ok(lines[2].includes(',1.50,4,'));
  assert.equal(fs.existsSync(path.join(ledgerDir, 'antigravity.csv')), false, 'Stale fallback file removed');

  const boardRes = rebuildBoardHtml(ledgerDir, ponytailDir);
  assert.equal(boardRes.renderer, 'ponytail');
  assert.equal(boardRes.totalTasks, 2);
  const html = fs.readFileSync(boardRes.boardFile, 'utf8');
  assert.ok(html.includes('Refactor billing'));
  assert.ok(html.includes('Add checkout validation'));
  assert.ok(html.includes('Agy · Orchestrator (Carbon)'));

  // Verify Ponytail's own modelName(m) parser keeps our label intact.
  const modelNameFn = new Function(
    'm',
    "var p = m.replace(/^claude-/, '').split('-'); return p[0] ? p[0][0].toUpperCase() + p[0].slice(1) + (p.length > 1 ? '\\u00a0' + p.slice(1).filter(function (x) { return x.length < 3 }).join('.') : '') : ''",
  );
  assert.equal(modelNameFn('Agy · Orchestrator (Carbon)'), 'Agy · Orchestrator (Carbon)');
});

test('SessionStart, Stop hooks, and importAllBrains end-to-end flow', t => {
  const tmp = makeTmpDir('pw-agy-hook-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);

  const ledgerDir = path.join(tmp, 'band');
  const repoDir = path.join(tmp, 'demo-repo');
  fs.mkdirSync(repoDir, { recursive: true });
  spawnSync('git', ['init', repoDir], { encoding: 'utf8' });

  const convId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
  const childId = '88888888-1111-2222-3333-444444444444';
  const brainDir = path.join(tmp, 'brain');
  const tPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
  const cPath = path.join(brainDir, childId, '.system_generated', 'logs', 'transcript.jsonl');

  writeJsonl(tPath, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-15T12:00:00Z',
      content: '<USER_REQUEST>\nWire up hook test\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T12:01:00Z',
      input_tokens: 200_000,
      cache_read_tokens: 100_000,
      output_tokens: 20_000,
      tool_calls: [{ name: 'invoke_subagent', args: {} }],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-15T12:01:05Z',
      content: `Spawned subagent conversationId="${childId}"`,
    },
  ]);

  writeJsonl(cPath, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-15T12:01:01Z',
      content: 'Subagent research',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T12:01:04Z',
      input_tokens: 50_000,
      cache_read_tokens: 0,
      output_tokens: 5_000,
      tool_calls: [],
    },
  ]);

  const startOut = handleHookPayload(
    {
      hookEventName: 'SessionStart',
      conversationId: convId,
      workspacePaths: [repoDir],
      modelName: 'gemini-4-carbon-high',
    },
    { ledgerDir, ponytailDir, allowTempWorkspaces: true },
  );
  assert.deepEqual(startOut, {});

  const stopOut = handleHookPayload(
    {
      hookEventName: 'Stop',
      conversationId: convId,
      workspacePaths: [repoDir],
      transcriptPath: tPath,
      modelName: 'auto', // Must keep non-auto model from SessionStart!
    },
    { ledgerDir, ponytailDir, allowTempWorkspaces: true },
  );
  assert.deepEqual(stopOut, { decision: 'allow' });
  assert.ok(fs.existsSync(path.join(ledgerDir, 'demo-repo.csv')));
  assert.ok(fs.existsSync(path.join(ledgerDir, 'board.html')));

  // Now run importAllBrains: child subagent must be rolled up into parent, not added separately!
  const imp = importAllBrains({ brainDirs: [brainDir], ledgerDir, ponytailDir, allowTempWorkspaces: true });
  assert.equal(imp.sessionsFound, 1);
  assert.equal(imp.totalBoardTasks, 1);

  // Smoke-test stdin execution via CLI subprocess.
  const cliRes = spawnSync(process.execPath, ['--no-warnings', SYNC_SCRIPT], {
    input: JSON.stringify({
      hookEventName: 'Stop',
      conversationId: convId,
      workspacePaths: [repoDir],
      transcriptPath: tPath,
      modelName: 'gemini-4-carbon-high',
    }),
    env: { ...process.env, PONYTAIL_BAND_DIR: ledgerDir, PONYTAIL_PLUGIN_DIR: ponytailDir, PONYTAIL_AGY_ALLOW_TEMP: '1' },
    encoding: 'utf8',
  });
  assert.equal(cliRes.status, 0);
  assert.deepEqual(JSON.parse(cliRes.stdout.trim()), { decision: 'allow' });
});

test('send_message reply from child to parent does not cycle or drop parent on import or child Stop', t => {
  const tmp = makeTmpDir('pw-agy-reply-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);

  const brainDir = path.join(tmp, 'brain');
  const ledgerDir = path.join(tmp, 'band');
  const parentId = '11111111-1111-1111-1111-111111111111';
  const childId = '22222222-2222-2222-2222-222222222222';
  const pPath = path.join(brainDir, parentId, '.system_generated', 'logs', 'transcript.jsonl');
  const cPath = path.join(brainDir, childId, '.system_generated', 'logs', 'transcript.jsonl');

  writeJsonl(pPath, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-15T10:00:00Z',
      content: '<USER_REQUEST>\nParent task\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:01:00Z',
      input_tokens: 100,
      cache_read_tokens: 0,
      output_tokens: 10,
      tool_calls: [{ name: 'invoke_subagent', args: {} }],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-15T10:01:02Z',
      content: `Subagent conversationId=${childId}`,
    },
  ]);

  writeJsonl(cPath, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-15T10:01:01Z',
      content: 'Child task',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:01:05Z',
      input_tokens: 50,
      cache_read_tokens: 0,
      output_tokens: 5,
      tool_calls: [{ name: 'send_message', args: { Recipient: parentId } }],
    },
  ]);

  const imp = importAllBrains({ brainDirs: [brainDir], ledgerDir, ponytailDir, allowTempWorkspaces: true });
  assert.equal(imp.sessionsFound, 1);
  assert.equal(imp.totalBoardTasks, 1);
  const importedCsv = fs.readFileSync(path.join(ledgerDir, 'antigravity.csv'), 'utf8');
  assert.ok(importedCsv.includes(',165,15,'), 'expected combined parent + child tokens');

  const stopLedger = path.join(tmp, 'stop-band');
  handleHookPayload(
    { hookEventName: 'Stop', conversationId: childId, transcriptPath: cPath },
    { ledgerDir: stopLedger, ponytailDir, allowTempWorkspaces: true },
  );
  const stopCsv = fs.readFileSync(path.join(stopLedger, 'antigravity.csv'), 'utf8');
  assert.ok(stopCsv.includes(',55,5,'), 'child Stop must not roll up parent tokens');
});

test('parallel invoke_subagent calls with interleaved tool results and grandchildren roll up transitively', t => {
  const tmp = makeTmpDir('pw-agy-tree-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);

  const brainDir = path.join(tmp, 'brain');
  const ledgerDir = path.join(tmp, 'band');
  const rootId = '11111111-1111-1111-1111-111111111111';
  const childA = '22222222-2222-2222-2222-222222222222';
  const childB = '33333333-3333-3333-3333-333333333333';
  const grandId = '44444444-4444-4444-4444-444444444444';
  const tp = id => path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');

  writeJsonl(tp(rootId), [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-15T10:00:00Z',
      content: '<USER_REQUEST>\nRoot task\n</USER_REQUEST>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:01:00Z',
      input_tokens: 100,
      cache_read_tokens: 0,
      output_tokens: 0,
      tool_calls: [{ name: 'read_file', args: {} }, { name: 'invoke_subagent', args: {} }, { name: 'invoke_subagent', args: {} }],
    },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', created_at: '2026-11-15T10:01:01Z', content: 'file content' },
    { step_index: 3, source: 'MODEL', type: 'GENERIC', created_at: '2026-11-15T10:01:02Z', content: `Subagent conversationId=${childA}` },
    { step_index: 4, source: 'MODEL', type: 'GENERIC', created_at: '2026-11-15T10:01:03Z', content: `Subagent conversationId=${childB}` },
  ]);

  writeJsonl(tp(childA), [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:01:04Z', content: 'Child A' },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:01:05Z',
      input_tokens: 200,
      cache_read_tokens: 0,
      output_tokens: 0,
      tool_calls: [{ name: 'invoke_subagent', args: {} }],
    },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', created_at: '2026-11-15T10:01:06Z', content: `Subagent conversationId=${grandId}` },
  ]);

  writeJsonl(tp(childB), [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:01:04Z', content: 'Child B' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-15T10:01:05Z', input_tokens: 300, cache_read_tokens: 0, output_tokens: 0, tool_calls: [] },
  ]);

  writeJsonl(tp(grandId), [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:01:07Z', content: 'Grandchild' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-15T10:01:08Z', input_tokens: 400, cache_read_tokens: 0, output_tokens: 0, tool_calls: [] },
  ]);

  const imp = importAllBrains({ brainDirs: [brainDir], ledgerDir, ponytailDir, allowTempWorkspaces: true });
  assert.equal(imp.sessionsFound, 1);
  assert.equal(imp.totalBoardTasks, 1);
  const csv = fs.readFileSync(path.join(ledgerDir, 'antigravity.csv'), 'utf8');
  assert.ok(csv.includes(',1000,0,'), 'expected combined 100+200+300+400 tokens on root');
});

test('rebuildBoardHtml falls back cleanly when Ponytail is not installed (standalone + fallback update)', t => {
  const tmp = makeTmpDir('pw-agy-standalone-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const ledgerDir = path.join(tmp, 'band');
  const missingPonytail = path.join(tmp, 'missing-ponytail');

  const firstStats = {
    startedMs: Date.parse('2026-11-15T09:00:00Z'),
    project: 'alpha',
    name: 'Initial standalone task',
    costUsd: 0.75,
    turns: 2,
    agentMs: 120_000,
    tokensTotal: 150_000,
    tokensOutput: 4_000,
    tests: '3 passed',
    level: 'full',
    model: 'Agy · Hydrogen',
  };
  upsertCsvRows(ledgerDir, [{ conversationId: '11111111-0000-0000-0000-000000000001', project: 'alpha', stats: firstStats }]);

  const standaloneRes = rebuildBoardHtml(ledgerDir, missingPonytail);
  assert.equal(standaloneRes.renderer, 'standalone');
  assert.equal(standaloneRes.totalTasks, 1);
  const firstHtml = fs.readFileSync(standaloneRes.boardFile, 'utf8');
  assert.ok(firstHtml.includes('<script type="application/json" id="board-data">'));
  const firstPayload = JSON.parse(firstHtml.match(/<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(firstPayload.tasks.length, 1);
  assert.equal(firstPayload.tasks[0].name, 'Initial standalone task');

  const secondStats = {
    startedMs: Date.parse('2026-11-15T10:00:00Z'),
    project: 'beta',
    name: 'Fix $& $$ and $1 fallback task',
    costUsd: 1.1,
    turns: 3,
    agentMs: 180_000,
    tokensTotal: 220_000,
    tokensOutput: 6_500,
    tests: 'not run',
    level: 'lite',
    model: 'Agy',
  };
  upsertCsvRows(ledgerDir, [{ conversationId: '22222222-0000-0000-0000-000000000002', project: 'beta', stats: secondStats }]);

  const fallbackRes = rebuildBoardHtml(ledgerDir, missingPonytail);
  assert.equal(fallbackRes.renderer, 'fallback');
  assert.equal(fallbackRes.totalTasks, 2);
  const updatedHtml = fs.readFileSync(fallbackRes.boardFile, 'utf8');
  const updatedPayload = JSON.parse(updatedHtml.match(/<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(updatedPayload.tasks.length, 2);
  assert.deepEqual(
    updatedPayload.tasks.map(task => task.name).sort(),
    ['Fix $& $$ and $1 fallback task', 'Initial standalone task'],
  );
});

test('withLedgerLock serializes parallel writers and cleans stale lockfiles', async t => {
  const tmp = makeTmpDir('pw-agy-lock-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ledgerDir = path.join(tmp, 'band');
  fs.mkdirSync(ledgerDir, { recursive: true });

  // Stale lockfile from a crashed process should be reclaimed without error.
  const staleLock = path.join(ledgerDir, '.agy-band.lock');
  fs.writeFileSync(staleLock, '999999\n', 'utf8');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(staleLock, past, past);

  upsertCsvRows(ledgerDir, [
    {
      conversationId: 'aaaaaaaa-0000-0000-0000-000000000001',
      project: 'concurrent',
      stats: {
        startedMs: Date.parse('2026-11-15T08:00:00Z'),
        project: 'concurrent',
        name: 'Initial row',
        costUsd: null,
        turns: 1,
        agentMs: 1000,
        tokensTotal: 10,
        tokensOutput: 1,
        tests: 'not run',
        level: 'full',
        model: 'Agy',
      },
    },
  ]);
  assert.equal(fs.existsSync(staleLock), false);

  const runWorker = (id, name) =>
    new Promise((resolve, reject) => {
      const script = `const { handleHookPayload, upsertCsvRows } = require(${JSON.stringify(SYNC_SCRIPT)});
handleHookPayload({ hookEventName: 'SessionStart', conversationId: ${JSON.stringify(id)}, workspacePaths: ['/opt/lxl/concurrent'], modelName: 'auto' }, { ledgerDir: ${JSON.stringify(ledgerDir)}, allowTempWorkspaces: true });
upsertCsvRows(${JSON.stringify(ledgerDir)}, [{ conversationId: ${JSON.stringify(id)}, project: 'concurrent', stats: { startedMs: 1763200000000, project: 'concurrent', name: ${JSON.stringify(name)}, costUsd: null, turns: 1, agentMs: 1000, tokensTotal: 20, tokensOutput: 2, tests: 'not run', level: 'full', model: 'Agy' } }]);`;
      const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
    });

  await Promise.all([
    runWorker('bbbbbbbb-0000-0000-0000-000000000002', 'Worker B'),
    runWorker('cccccccc-0000-0000-0000-000000000003', 'Worker C'),
  ]);

  const cache = JSON.parse(fs.readFileSync(path.join(ledgerDir, '.agy-sessions.json'), 'utf8'));
  assert.ok(cache['bbbbbbbb-0000-0000-0000-000000000002']);
  assert.ok(cache['cccccccc-0000-0000-0000-000000000003']);
  const csv = fs.readFileSync(path.join(ledgerDir, 'concurrent.csv'), 'utf8');
  assert.ok(csv.includes('Worker B'));
  assert.ok(csv.includes('Worker C'));
  assert.equal(fs.existsSync(staleLock), false);
});

test('tracks background run_command test runs across non-test descriptions and multi-task completion messages', t => {
  const tmp = makeTmpDir('pw-agy-bg-test-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);

  const tPath = path.join(tmp, 'bg.jsonl');
  writeJsonl(tPath, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-15T10:00:00Z',
      content: 'Verify interleaved sync/background commands',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:00:05Z',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: '"git status"' } },
        { name: 'run_command', args: { CommandLine: '"npm test"' } },
        { name: 'run_command', args: { CommandLine: '"pytest"' } },
      ],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-15T10:00:06Z',
      content: 'Tool is running as a background task with task id: t0\nTask Description: Check git status',
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-15T10:00:07Z',
      content: 'Tool is running as a background task with task id: t1\nTask Description: Verification run',
    },
    {
      step_index: 4,
      source: 'MODEL',
      type: 'GENERIC',
      created_at: '2026-11-15T10:00:08Z',
      content: 'Command exited with code 0.\n\n7 passed in 0.1s\n',
    },
    {
      step_index: 5,
      source: 'MODEL',
      type: 'SYSTEM_MESSAGE',
      created_at: '2026-11-15T10:00:10Z',
      content:
        'Task id "t0" finished with result:\nCommand exited with code 1.\n\nTask id "t1" finished with result:\nCommand exited with code 0.\n9 passed\n</SYSTEM_MESSAGE>',
    },
  ]);

  const stats = parseAgyTranscript(tPath, {}, [], { ponytailDir, allowTempWorkspaces: true });
  assert.ok(stats);
  assert.equal(stats.tests, '9 passed');
});

test('csvField quotes bare carriage returns so RFC-4180 CSV round-trip preserves single row', t => {
  const tmp = makeTmpDir('pw-agy-csv-cr-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const taskName = 'Fix\rCR "quoted", title';
  upsertCsvRows(tmp, [
    {
      conversationId: 'aaaaaaaa-1111-2222-3333-444444444444',
      project: 'crproj',
      stats: {
        startedMs: Date.parse('2026-11-15T09:00:00Z'),
        project: 'crproj',
        name: taskName,
        costUsd: null,
        turns: 1,
        agentMs: 1000,
        tokensTotal: 25,
        tokensOutput: 5,
        tests: 'not run',
        level: 'full',
        model: 'Agy',
      },
    },
  ]);

  const board = rebuildBoardHtml(tmp, path.join(tmp, 'missing-ponytail'));
  assert.equal(board.totalTasks, 1);
  const html = fs.readFileSync(board.boardFile, 'utf8');
  const payload = JSON.parse(html.match(/<script type="application\/json" id="board-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.tasks[0].name, taskName);
});

test('child subagents inherit spawn-time model across parent model switches and honor enter_plan_mode', t => {
  const tmp = makeTmpDir('pw-agy-submodel-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);

  const parentPath = path.join(tmp, 'parent.jsonl');
  const childPath = path.join(tmp, 'child.jsonl');

  writeJsonl(parentPath, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-15T10:00:00Z',
      content:
        '<USER_REQUEST>\nSwitch model mid-session\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Orchestrator (Carbon).\n</USER_SETTINGS_CHANGE>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:01:00Z',
      tool_calls: [{ name: 'invoke_subagent', args: {} }],
    },
    {
      step_index: 2,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-15T10:05:00Z',
      content:
        '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Orchestrator (Carbon) to auto.\n</USER_SETTINGS_CHANGE>',
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:05:05Z',
      tool_calls: [],
    },
  ]);

  writeJsonl(childPath, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:01:01Z', content: 'sub' },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:01:02Z',
      tool_calls: [{ name: 'exit_plan_mode', args: {} }],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:01:03Z',
      tool_calls: [{ name: 'enter_plan_mode', args: {} }],
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:01:04Z',
      input_tokens: 1_000_000,
      cache_read_tokens: 0,
      output_tokens: 0,
      tool_calls: [],
    },
  ]);

  const stats = parseAgyTranscript(parentPath, {}, [childPath], { ponytailDir, allowTempWorkspaces: true });
  assert.ok(stats);
  assert.equal(stats.model, 'Agy');
  assert.ok(stats.costUsd !== null && Math.abs(stats.costUsd - 2.0) < 1e-6, `expected $2.00 got ${stats.costUsd}`);
});

test('isSourceCodeFile checks SKIP_SOURCE_DIR relative to repo root even under a /build/ parent dir', t => {
  const tmp = makeTmpDir('pw-agy-build-parent-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);

  const repo = path.join(tmp, 'build', 'my-app');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  spawnSync('git', ['init', repo], { stdio: 'ignore' });
  const srcFile = path.join(repo, 'src', 'index.js');
  const testFile = path.join(repo, 'tests', 'foo.js');
  fs.writeFileSync(srcFile, 'module.exports = 1;\n');
  fs.writeFileSync(testFile, 'module.exports = 2;\n');

  const testEditPath = path.join(tmp, 'test-only.jsonl');
  writeJsonl(testEditPath, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:00:00Z', content: 'Edit test' },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:00:05Z',
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"' } }],
    },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', created_at: '2026-11-15T10:00:10Z', content: 'Command exited with code 0.\n3 passed' },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:00:15Z',
      tool_calls: [{ name: 'edit_file', args: { Path: JSON.stringify(testFile) } }],
    },
  ]);
  const sTest = parseAgyTranscript(testEditPath, { cwd: repo }, [], { ponytailDir, allowTempWorkspaces: true });
  assert.equal(sTest.tests, '3 passed');

  const srcEditPath = path.join(tmp, 'src-edit.jsonl');
  writeJsonl(srcEditPath, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:01:00Z', content: 'Edit src' },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:01:05Z',
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"' } }],
    },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', created_at: '2026-11-15T10:01:10Z', content: 'Command exited with code 0.\n3 passed' },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:01:15Z',
      tool_calls: [{ name: 'edit_file', args: { Path: JSON.stringify(srcFile) } }],
    },
  ]);
  const sSrc = parseAgyTranscript(srcEditPath, { cwd: repo }, [], { ponytailDir, allowTempWorkspaces: true });
  assert.equal(sSrc.tests, 'stale');
});

test('handleHookPayload keeps valid cached cwd when Stop passes ignored paths and projectOf resolves deleted git subdirs', t => {
  const tmp = makeTmpDir('pw-agy-cwd-guard-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);
  const ledgerDir = path.join(tmp, 'band');
  const repo = path.join(tmp, 'real-repo');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', repo], { stdio: 'ignore' });

  const { projectOf } = require(SYNC_SCRIPT);
  assert.equal(projectOf(path.join(repo, 'missing', 'nested'), new Map()), 'real-repo');

  const convId = '11111111-1111-1111-1111-111111111111';
  handleHookPayload(
    { hookEventName: 'SessionStart', conversationId: convId, workspacePaths: [repo] },
    { ledgerDir, ponytailDir, allowTempWorkspaces: true },
  );
  handleHookPayload(
    { hookEventName: 'Stop', conversationId: convId, workspacePaths: [`${os.homedir()}/`] },
    { ledgerDir, ponytailDir, allowTempWorkspaces: true },
  );
  handleHookPayload(
    { hookEventName: 'Stop', conversationId: convId, workspacePaths: [path.join(os.homedir(), '.gemini')] },
    { ledgerDir, ponytailDir, allowTempWorkspaces: true },
  );
  const cache = JSON.parse(fs.readFileSync(path.join(ledgerDir, '.agy-sessions.json'), 'utf8'));
  assert.equal(cache[convId].cwd, repo);
});

test('CLI stdin decodes multi-byte UTF-8 sequences split across chunk writes', async t => {
  const tmp = makeTmpDir('pw-agy-stdin-utf8-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);
  const ledgerDir = path.join(tmp, 'band');
  const repoDir = path.join(tmp, 'demo-utf8');
  fs.mkdirSync(repoDir, { recursive: true });
  spawnSync('git', ['init', repoDir], { stdio: 'ignore' });

  const convId = '33333333-3333-3333-3333-333333333333';
  const tPath = path.join(tmp, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  const title = 'UTF8 ·🚀 title';
  writeJsonl(tPath, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:00:00Z', content: title },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-15T10:00:05Z', input_tokens: 100, cache_read_tokens: 0, output_tokens: 10, tool_calls: [] },
  ]);

  const jsonBuf = Buffer.from(
    JSON.stringify({
      hookEventName: 'Stop',
      conversationId: convId,
      workspacePaths: [repoDir],
      transcriptPath: tPath,
      customLabel: title,
    }),
    'utf8',
  );
  const splitIdx = jsonBuf.indexOf(Buffer.from([0xc2, 0xb7])) + 1;
  assert.ok(splitIdx > 1);

  const child = spawn(process.execPath, ['--no-warnings', SYNC_SCRIPT], {
    env: { ...process.env, PONYTAIL_BAND_DIR: ledgerDir, PONYTAIL_PLUGIN_DIR: ponytailDir, PONYTAIL_AGY_ALLOW_TEMP: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', d => { stdout += d.toString('utf8'); });
  child.stdin.write(jsonBuf.subarray(0, splitIdx));
  await new Promise(r => setTimeout(r, 15));
  const emojiIdx = jsonBuf.indexOf(Buffer.from([0xf0, 0x9f, 0x9a, 0x80])) + 2;
  child.stdin.write(jsonBuf.subarray(splitIdx, emojiIdx));
  await new Promise(r => setTimeout(r, 15));
  child.stdin.end(jsonBuf.subarray(emojiIdx));

  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.trim()), { decision: 'allow' });
  const csvText = fs.readFileSync(path.join(ledgerDir, 'demo-utf8.csv'), 'utf8');
  assert.ok(csvText.includes(title), `expected ${title} in ${csvText}`);
  assert.ok(!csvText.includes('\uFFFD'));
});

test('upsertCsvRows matches short IDs, reports exact update counts, and removes moved sibling rows', t => {
  const tmp = makeTmpDir('pw-agy-move-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const stats = {
    startedMs: 1763200000000,
    project: 'alpha',
    name: 'Move session',
    costUsd: 0.25,
    turns: 1,
    agentMs: 1000,
    tokensTotal: 100,
    tokensOutput: 20,
    tests: 'not run',
    level: 'full',
    model: 'Agy',
  };
  const keepStats = { ...stats, startedMs: 1763200005000, name: 'Stay in alpha' };

  assert.equal(
    upsertCsvRows(tmp, [
      { conversationId: 'short', project: 'alpha', stats },
      { conversationId: 'stayid', project: 'alpha', stats: keepStats },
    ]),
    2,
  );
  // Identical repeat upsert must report 0 updated rows.
  assert.equal(upsertCsvRows(tmp, [{ conversationId: 'short', project: 'alpha', stats }]), 0);
  // Updating a short-ID session increments count by 1 and deduplicates rather than adding a second row.
  assert.equal(upsertCsvRows(tmp, [{ conversationId: 'short', project: 'alpha', stats: { ...stats, turns: 2 } }]), 1);
  assert.equal(fs.readFileSync(path.join(tmp, 'alpha.csv'), 'utf8').trim().split('\n').length, 3);

  // Moving 'short' to beta prunes 'short' from alpha.csv while keeping 'stayid', then moving 'stayid' removes empty alpha.csv.
  assert.equal(upsertCsvRows(tmp, [{ conversationId: 'short', project: 'beta', stats: { ...stats, project: 'beta' } }]), 1);
  const alphaLines = fs.readFileSync(path.join(tmp, 'alpha.csv'), 'utf8').trim().split('\n');
  assert.equal(alphaLines.length, 2);
  assert.ok(!alphaLines.some(l => l.startsWith('short-')));

  assert.equal(upsertCsvRows(tmp, [{ conversationId: 'stayid', project: 'beta', stats: { ...keepStats, project: 'beta' } }]), 1);
  assert.equal(fs.existsSync(path.join(tmp, 'alpha.csv')), false);
});

test('streamJsonl skips malformed JSON lines while letting onRecord exceptions propagate', t => {
  const tmp = makeTmpDir('pw-agy-stream-err-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, 'mixed.jsonl');
  fs.writeFileSync(file, '{"ok":1}\n{not valid json\n{"ok":2}\n', 'utf8');

  const seen = [];
  streamJsonl(file, rec => seen.push(rec.ok));
  assert.deepEqual(seen, [1, 2]);

  assert.throws(
    () =>
      streamJsonl(file, rec => {
        if (rec.ok === 2) throw new Error('callback boom');
      }),
    /callback boom/,
  );
});

test('getClaudePrices caches custom tariffs per resolved ponytailDir', t => {
  const tmp = makeTmpDir('pw-agy-prices-dir-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const d1 = path.join(tmp, 'p1');
  const d2 = path.join(tmp, 'p2');
  for (const [dir, rate] of [
    [d1, 10],
    [d2, 20],
  ]) {
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks', 'ponytail-band-import.js'), `exports.PRICES = { 'claude-custom-x': [${rate}, 0, 0, 0, 0] };`);
  }
  assert.equal(estimateStepCost('claude-custom-x', false, 1_000_000, 0, 0, d1), 10);
  assert.equal(estimateStepCost('claude-custom-x', false, 1_000_000, 0, 0, d2), 20);
  assert.equal(estimateStepCost('claude-custom-x', false, 1_000_000, 0, 0, path.join(tmp, 'p1', '.')), 10);
});

test('parseAgyTranscript skips scorePath git probes when meta.cwd is valid', t => {
  const tmp = makeTmpDir('pw-agy-skip-score-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'explicit-repo');
  const other = path.join(tmp, 'other-repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(other, 'src'), { recursive: true });
  spawnSync('git', ['init', repo], { stdio: 'ignore' });
  spawnSync('git', ['init', other], { stdio: 'ignore' });

  const transcript = path.join(tmp, 't.jsonl');
  writeJsonl(transcript, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:00:00Z', content: 'Go' },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-15T10:00:05Z',
      tool_calls: [
        { name: 'read_file', args: { Path: JSON.stringify(path.join(other, 'src', 'a.js')) } },
        { name: 'run_command', args: { Cwd: JSON.stringify(other), CommandLine: JSON.stringify(`ls ${other}`) } },
      ],
    },
  ]);

  const cpMod = require('node:child_process');
  const origSpawnSync = cpMod.spawnSync;
  let gitCalls = 0;
  cpMod.spawnSync = function (cmd) {
    if (cmd === 'git') gitCalls++;
    return origSpawnSync.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(SYNC_SCRIPT)];
    const { parseAgyTranscript: freshParse } = require(SYNC_SCRIPT);
    const stats = freshParse(transcript, { cwd: repo }, [], { allowTempWorkspaces: true, ponytailDir: tmp });
    assert.equal(stats.project, 'explicit-repo');
    assert.ok(gitCalls <= 1, `expected <= 1 git call, got ${gitCalls}`);
  } finally {
    cpMod.spawnSync = origSpawnSync;
    delete require.cache[require.resolve(SYNC_SCRIPT)];
    require(SYNC_SCRIPT);
  }
});

test('importAllBrains and Stop open each .jsonl transcript file only once', t => {
  const tmp = makeTmpDir('pw-agy-single-read-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);
  const brainDir = path.join(tmp, 'brain');
  const ledgerDir = path.join(tmp, 'band');
  const pId = '11111111-1111-1111-1111-111111111111';
  const cId = '22222222-2222-2222-2222-222222222222';
  const pFile = path.join(brainDir, pId, '.system_generated', 'logs', 'transcript.jsonl');
  const cFile = path.join(brainDir, cId, '.system_generated', 'logs', 'transcript.jsonl');

  writeJsonl(pFile, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:00:00Z', content: 'Parent' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-15T10:00:05Z', input_tokens: 100, cache_read_tokens: 0, output_tokens: 10, tool_calls: [{ name: 'invoke_subagent', args: {} }] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', created_at: '2026-11-15T10:00:06Z', content: `Spawned subagent conversationId="${cId}"` },
  ]);
  writeJsonl(cFile, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:00:07Z', content: 'Child' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-15T10:00:08Z', input_tokens: 50, cache_read_tokens: 0, output_tokens: 5, tool_calls: [] },
  ]);

  let opens = 0;
  const origOpenSync = fs.openSync;
  fs.openSync = function (p) {
    if (String(p).endsWith('.jsonl')) opens++;
    return origOpenSync.apply(this, arguments);
  };
  try {
    const res = importAllBrains({ brainDirs: [brainDir], ledgerDir, ponytailDir, allowTempWorkspaces: true });
    assert.equal(res.sessionsFound, 1);
    assert.equal(opens, 2, `expected 2 opens for 2 transcripts, got ${opens}`);

    opens = 0;
    handleHookPayload(
      { hookEventName: 'Stop', conversationId: pId, transcriptPath: pFile },
      { ledgerDir, ponytailDir, allowTempWorkspaces: true },
    );
    assert.equal(opens, 2, `expected 2 opens on Stop, got ${opens}`);
  } finally {
    fs.openSync = origOpenSync;
  }
});

test('estimateStepCost covers Gemini and Claude tiered pricing and CLI --import runs end-to-end', t => {
  const tmp = makeTmpDir('pw-agy-tiers-cli-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);

  const approx = (actual, expected, label) => {
    assert.ok(actual !== null && Math.abs(actual - expected) < 1e-6, `${label}: expected ${expected}, got ${actual}`);
  };

  approx(estimateStepCost('gemini-3.8-flash-high', false, 1_000_000, 1_000_000, 1_000_000, ponytailDir), 4.575, 'gemini-3.8-flash');
  approx(estimateStepCost('gemini-3.5-flash-lite', false, 1_000_000, 1_000_000, 1_000_000, ponytailDir), 2.83, 'gemini-3.5-flash-lite');
  approx(estimateStepCost('gemini-3.1-flash-lite', false, 1_000_000, 1_000_000, 1_000_000, ponytailDir), 1.775, 'gemini-3.1-flash-lite');
  approx(estimateStepCost('gemini-3.1-pro-high', false, 100_000, 100_000, 1_000_000, ponytailDir), 12.22, 'gemini-3.1-pro <=200k');
  approx(estimateStepCost('gemini-3.1-pro-high', false, 200_000, 100_000, 1_000_000, ponytailDir), 18.84, 'gemini-3.1-pro >200k');
  approx(estimateStepCost('gemini-2.5-pro', false, 1_000_000, 1_000_000, 1_000_000, ponytailDir), 11.375, 'gemini-2.5-pro');
  approx(estimateStepCost('gemini-2.5-flash', false, 1_000_000, 1_000_000, 1_000_000, ponytailDir), 2.83, 'gemini-2.5-flash');
  approx(estimateStepCost('claude-haiku-5-5', false, 50_000, 50_000, 1_000_000, ponytailDir), 0.5055, 'claude-haiku-5-5 <=100k');
  approx(estimateStepCost('claude-haiku-5-5', false, 100_000, 50_000, 1_000_000, ponytailDir), 2.5525, 'claude-haiku-5-5 >100k');

  const brainDir = path.join(tmp, 'brain');
  const ledgerDir = path.join(tmp, 'band');
  const repoDir = path.join(tmp, 'cli-import-repo');
  fs.mkdirSync(repoDir, { recursive: true });
  spawnSync('git', ['init', repoDir], { stdio: 'ignore' });

  const convId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const tFile = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
  writeJsonl(tFile, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:00:00Z', content: 'Run CLI import' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-15T10:00:10Z', input_tokens: 100_000, cache_read_tokens: 0, output_tokens: 10_000, tool_calls: [{ name: 'read_file', args: { Path: JSON.stringify(path.join(repoDir, 'a.js')) } }] },
  ]);

  const res = spawnSync(
    process.execPath,
    ['--no-warnings', SYNC_SCRIPT, '--import', '--brain-dir', brainDir, '--ledger-dir', ledgerDir, '--ponytail-dir', ponytailDir],
    {
      env: { ...process.env, PONYTAIL_AGY_ALLOW_TEMP: '1' },
      encoding: 'utf8',
    },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /ponytail-agy-band import: 1 agy session\(s\) parsed, 1 row\(s\) updated, 1 total task\(s\)/);
  assert.ok(fs.existsSync(path.join(ledgerDir, 'cli-import-repo.csv')));
  assert.ok(fs.existsSync(path.join(ledgerDir, 'board.html')));
});

test('CLI --import supports repeatable --project filters and --json output', t => {
  const tmp = makeTmpDir('pw-agy-project-json-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);
  const brainDir = path.join(tmp, 'brain');
  const ledgerDir = path.join(tmp, 'band');

  for (const [id, proj] of [
    ['11111111-1111-1111-1111-111111111111', 'Alpha'],
    ['22222222-2222-2222-2222-222222222222', 'beta'],
    ['33333333-3333-3333-3333-333333333333', 'gamma'],
  ]) {
    const r = path.join(tmp, proj);
    fs.mkdirSync(r, { recursive: true });
    writeJsonl(path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl'), [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:00:00Z', content: `Work in ${proj}` },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-15T10:00:05Z', input_tokens: 100, cache_read_tokens: 0, output_tokens: 10, tool_calls: [{ name: 'read_file', args: { Path: JSON.stringify(path.join(r, 'f.js')) } }] },
    ]);
  }

  const res = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      SYNC_SCRIPT,
      '--import',
      '--brain-dir',
      brainDir,
      '--ledger-dir',
      ledgerDir,
      '--ponytail-dir',
      ponytailDir,
      '--project',
      'alpha',
      '--project',
      'gamma',
      '--json',
    ],
    { env: { ...process.env, PONYTAIL_AGY_ALLOW_TEMP: '1' }, encoding: 'utf8' },
  );
  assert.equal(res.status, 0, res.stderr);
  const json = JSON.parse(res.stdout.trim());
  assert.equal(json.sessionsFound, 2);
  assert.equal(json.rowsUpdated, 2);
  assert.equal(json.totalBoardTasks, 2);
  assert.equal(fs.existsSync(path.join(ledgerDir, 'Alpha.csv')), true);
  assert.equal(fs.existsSync(path.join(ledgerDir, 'gamma.csv')), true);
  assert.equal(fs.existsSync(path.join(ledgerDir, 'beta.csv')), false);
});

test('handleHookPayload persists customLabel/title and PONYTAIL_AGY_BRAIN_DIRS overrides default brain scan', t => {
  const tmp = makeTmpDir('pw-agy-label-env-');
  const prevEnv = process.env.PONYTAIL_AGY_BRAIN_DIRS;
  t.after(() => {
    if (prevEnv === undefined) delete process.env.PONYTAIL_AGY_BRAIN_DIRS;
    else process.env.PONYTAIL_AGY_BRAIN_DIRS = prevEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const ponytailDir = makePonytailFixture(tmp);
  const b1 = path.join(tmp, 'b1');
  const b2 = path.join(tmp, 'b2');
  const ledgerDir = path.join(tmp, 'band');
  const id = '44444444-4444-4444-4444-444444444444';
  const tFile = path.join(b1, id, '.system_generated', 'logs', 'transcript.jsonl');
  writeJsonl(tFile, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:00:00Z', content: 'Ignored prompt name' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-15T10:00:05Z', input_tokens: 100, cache_read_tokens: 0, output_tokens: 10, tool_calls: [] },
  ]);

  process.env.PONYTAIL_AGY_BRAIN_DIRS = [b1, b2, path.join(tmp, 'nonexistent')].join(path.delimiter);
  handleHookPayload(
    { hookEventName: 'SessionStart', conversationId: id, customLabel: 'Pinned  Integration\nTitle' },
    { ledgerDir, ponytailDir, allowTempWorkspaces: true },
  );
  handleHookPayload(
    { hookEventName: 'Stop', conversationId: id, transcriptPath: tFile },
    { ledgerDir, ponytailDir, allowTempWorkspaces: true },
  );
  const res = importAllBrains({ ledgerDir, ponytailDir, allowTempWorkspaces: true });
  assert.equal(res.sessionsFound, 1);
  const csv = fs.readFileSync(path.join(ledgerDir, 'antigravity.csv'), 'utf8');
  assert.ok(csv.includes('Pinned Integration Title'));
  assert.ok(!csv.includes('Ignored prompt name'));
});

test('CLI --help/-h prints usage and --status reports diagnostics without mutating disk', t => {
  const tmp = makeTmpDir('pw-agy-help-status-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  for (const flag of ['--help', '-h']) {
    const helpRes = spawnSync(process.execPath, ['--no-warnings', SYNC_SCRIPT, flag], { encoding: 'utf8' });
    assert.equal(helpRes.status, 0, helpRes.stderr);
    assert.match(helpRes.stdout, /--import/);
    assert.match(helpRes.stdout, /--status/);
    assert.match(helpRes.stdout, /--project/);
  }

  const brainDir = path.join(tmp, 'brain');
  const uncreatedLedger = path.join(tmp, 'band-uncreated');
  const convId = '55555555-5555-5555-5555-555555555555';
  const tFile = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
  writeJsonl(tFile, []);

  assert.equal(collectBrainSessions([brainDir]).length, 1);

  const standaloneRes = spawnSync(
    process.execPath,
    ['--no-warnings', SYNC_SCRIPT, '--status', '--brain-dir', brainDir, '--ledger-dir', uncreatedLedger, '--ponytail-dir', tmp, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(standaloneRes.status, 0, standaloneRes.stderr);
  const st = JSON.parse(standaloneRes.stdout.trim());
  assert.deepEqual(st.brainDirs, [brainDir]);
  assert.equal(st.conversationCount, 1);
  assert.equal(st.ledgerDir, uncreatedLedger);
  assert.deepEqual(st.csvFiles, []);
  assert.equal(st.ponytailDir, null);
  assert.equal(st.boardMode, 'standalone');
  assert.equal(fs.existsSync(uncreatedLedger), false);

  const ponytailDir = makePonytailFixture(tmp);
  fs.mkdirSync(uncreatedLedger, { recursive: true });
  fs.writeFileSync(path.join(uncreatedLedger, 'demo.csv'), `${CSV_HEADER}\n`, 'utf8');

  const humanRes = spawnSync(
    process.execPath,
    ['--no-warnings', SYNC_SCRIPT, '--status', '--brain-dir', brainDir, '--ledger-dir', uncreatedLedger, '--ponytail-dir', ponytailDir],
    { encoding: 'utf8' },
  );
  assert.equal(humanRes.status, 0, humanRes.stderr);
  assert.match(humanRes.stdout, /conversations: 1/);
  assert.match(humanRes.stdout, /1 csv file\(s\)/);
  assert.match(humanRes.stdout, /boardMode: ponytail/);

  const direct = inspectBandStatus({ brainDirs: [brainDir], ledgerDir: uncreatedLedger, ponytailDir });
  assert.deepEqual(direct.csvFiles, ['demo.csv']);
  assert.equal(direct.boardMode, 'ponytail');

  const emptyDirect = inspectBandStatus({ brainDirs: [], ledgerDir: uncreatedLedger, ponytailDir: tmp });
  assert.deepEqual(emptyDirect.brainDirs, []);
  assert.equal(emptyDirect.conversationCount, 0);
});

test('withLedgerLock sweeps stale atomic write temp files and honors PONYTAIL_LOCK_TIMEOUT_MS', t => {
  const tmp = makeTmpDir('pw-agy-sweep-timeout-');
  const prevTimeout = process.env.PONYTAIL_LOCK_TIMEOUT_MS;
  t.after(() => {
    if (prevTimeout === undefined) delete process.env.PONYTAIL_LOCK_TIMEOUT_MS;
    else process.env.PONYTAIL_LOCK_TIMEOUT_MS = prevTimeout;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const ledgerDir = path.join(tmp, 'band');
  fs.mkdirSync(ledgerDir, { recursive: true });
  const staleTmp = path.join(ledgerDir, 'proj.csv.tmp.99999.1000.1');
  const freshTmp = path.join(ledgerDir, 'proj.csv.tmp.99999.1000.2');
  const realCsv = path.join(ledgerDir, 'proj.csv');
  fs.writeFileSync(staleTmp, 'old', 'utf8');
  fs.writeFileSync(freshTmp, 'new', 'utf8');
  fs.writeFileSync(realCsv, `${CSV_HEADER}\n`, 'utf8');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(staleTmp, past, past);

  assert.equal(sweepStaleTempFiles(path.join(tmp, 'missing-dir'), 15000), 0);
  withLedgerLock(ledgerDir, () => {});
  assert.equal(fs.existsSync(staleTmp), false);
  assert.equal(fs.existsSync(freshTmp), true);
  assert.equal(fs.existsSync(realCsv), true);

  const lockFile = path.join(ledgerDir, '.agy-band.lock');
  fs.writeFileSync(lockFile, '12345\n', 'utf8');
  process.env.PONYTAIL_LOCK_TIMEOUT_MS = '40';
  const start = Date.now();
  assert.throws(() => withLedgerLock(ledgerDir, () => {}), /Timed out waiting for ledger lock/);
  assert.ok(Date.now() - start < 1000, 'should honor PONYTAIL_LOCK_TIMEOUT_MS instead of waiting 5000ms');
});

test('importAllBrains caches unchanged transcripts across runs, invalidates on child edits, and supports --force', t => {
  const tmp = makeTmpDir('pw-agy-import-cache-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);
  const brainDir = path.join(tmp, 'brain');
  const ledgerDir = path.join(tmp, 'band');
  const repoDir = path.join(tmp, 'cache-proj');
  fs.mkdirSync(repoDir, { recursive: true });
  spawnSync('git', ['init', repoDir], { stdio: 'ignore' });

  const pId = '66666666-6666-6666-6666-666666666666';
  const cId = '77777777-7777-7777-7777-777777777777';
  const pFile = path.join(brainDir, pId, '.system_generated', 'logs', 'transcript.jsonl');
  const cFile = path.join(brainDir, cId, '.system_generated', 'logs', 'transcript.jsonl');

  writeJsonl(pFile, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:00:00Z', content: 'Cache test' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-15T10:00:05Z', input_tokens: 100, cache_read_tokens: 0, output_tokens: 10, tool_calls: [{ name: 'invoke_subagent', args: {} }, { name: 'read_file', args: { Path: JSON.stringify(path.join(repoDir, 'a.js')) } }] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', created_at: '2026-11-15T10:00:06Z', content: `Spawned subagent conversationId="${cId}"` },
  ]);
  writeJsonl(cFile, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:00:07Z', content: 'Child' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-15T10:00:08Z', input_tokens: 50, cache_read_tokens: 0, output_tokens: 5, tool_calls: [] },
  ]);

  let opens = 0;
  const origOpenSync = fs.openSync;
  fs.openSync = function (p) {
    if (String(p).endsWith('.jsonl')) opens++;
    return origOpenSync.apply(this, arguments);
  };
  try {
    const r1 = importAllBrains({ brainDirs: [brainDir], ledgerDir, ponytailDir, allowTempWorkspaces: true });
    assert.equal(r1.sessionsFound, 1);
    assert.equal(r1.cachedSessions, 0);
    assert.equal(opens, 2);
    assert.equal(fs.existsSync(path.join(ledgerDir, '.agy-import-cache.json')), true);

    opens = 0;
    const r2 = importAllBrains({ brainDirs: [brainDir], ledgerDir, ponytailDir, allowTempWorkspaces: true });
    assert.equal(r2.sessionsFound, 1);
    assert.equal(r2.cachedSessions, 1);
    assert.equal(r2.rowsUpdated, 0);
    assert.equal(opens, 0, 'warm importAllBrains should perform 0 .jsonl opens');

    // Touch child transcript with extra tokens -> must invalidate parent's rootCache.
    opens = 0;
    fs.appendFileSync(
      cFile,
      `${JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-15T10:00:09Z', input_tokens: 30, cache_read_tokens: 0, output_tokens: 5, tool_calls: [] })}\n`,
    );
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(cFile, future, future);
    const r3 = importAllBrains({ brainDirs: [brainDir], ledgerDir, ponytailDir, allowTempWorkspaces: true });
    assert.equal(r3.cachedSessions, 0);
    assert.equal(r3.rowsUpdated, 1);
    assert.ok(opens >= 1);
  } finally {
    fs.openSync = origOpenSync;
  }

  const cliForce = spawnSync(
    process.execPath,
    ['--no-warnings', SYNC_SCRIPT, '--import', '--force', '--brain-dir', brainDir, '--ledger-dir', ledgerDir, '--ponytail-dir', ponytailDir, '--json'],
    { env: { ...process.env, PONYTAIL_AGY_ALLOW_TEMP: '1' }, encoding: 'utf8' },
  );
  assert.equal(cliForce.status, 0, cliForce.stderr);
  const parsedForce = JSON.parse(cliForce.stdout.trim());
  assert.equal(parsedForce.sessionsFound, 1);
  assert.equal(parsedForce.cachedSessions, 0);
});

test('CLI rejects invalid flags, missing values, --*=*, orphan modifiers, and conflicting modes with exit 2', () => {
  const invalidCases = [
    ['--unknown'],
    ['-x'],
    ['positional-arg'],
    ['--brain-dir'],
    ['--project'],
    ['--ledger-dir'],
    ['--ponytail-dir'],
    ['--brain-dir', ''],
    ['--project', ''],
    ['--brain-dir', '--json'],
    ['--brain-dir', '--help'],
    ['--brain-dir=foo'],
    ['--import=true'],
    ['--force'],
    ['--json'],
    ['--project', 'foo'],
    ['--brain-dir', 'foo'],
    ['--ledger-dir', 'foo'],
    ['--ponytail-dir', 'foo'],
    ['--import', '--status'],
    ['--unknown', '--help'],
    ['--help', '--unknown'],
    ['--import=false', '-h'],
  ];

  for (const args of invalidCases) {
    const res = spawnSync(process.execPath, ['--no-warnings', SYNC_SCRIPT, ...args], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(res.error, undefined, `unexpected error for ${JSON.stringify(args)}: ${res.error}`);
    assert.equal(res.status, 2, `expected exit 2 for ${JSON.stringify(args)}, got ${res.status} stderr=${res.stderr}`);
    assert.equal(res.stdout, '', `expected empty stdout for ${JSON.stringify(args)}`);
    assert.ok(res.stderr.includes('--help'), `expected --help hint on stderr for ${JSON.stringify(args)}`);
  }

  for (const helpArgs of [['--import', '--help'], ['--import', '--status', '-h']]) {
    const res = spawnSync(process.execPath, ['--no-warnings', SYNC_SCRIPT, ...helpArgs], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(res.error, undefined);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stdout.includes('Usage:'));
    assert.equal(res.stderr, '');
  }
});

test('hook stdin handles BOM Stop payloads, malformed Stop JSON, non-Stop errors, and ledger lock timeout fail-open', t => {
  const tmp = makeTmpDir('pw-agy-stdin-failopen-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ponytailDir = makePonytailFixture(tmp);
  const ledgerDir = path.join(tmp, 'band');
  const repoDir = path.join(tmp, 'bom-proj');
  fs.mkdirSync(repoDir, { recursive: true });
  spawnSync('git', ['init', repoDir], { stdio: 'ignore' });

  const convId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const tPath = path.join(tmp, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  writeJsonl(tPath, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:00:00Z', content: 'BOM Stop test' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-15T10:00:05Z', input_tokens: 100, cache_read_tokens: 0, output_tokens: 10, tool_calls: [] },
  ]);

  const baseEnv = {
    ...process.env,
    PONYTAIL_BAND_DIR: ledgerDir,
    PONYTAIL_PLUGIN_DIR: ponytailDir,
    PONYTAIL_AGY_ALLOW_TEMP: '1',
  };

  // (a) UTF-8 BOM-prefixed valid Stop payload persists CSV row and allows Stop.
  const bomPayload = `\uFEFF${JSON.stringify({
    hookEventName: 'Stop',
    conversationId: convId,
    workspacePaths: [repoDir],
    transcriptPath: tPath,
  })}`;
  const bomRes = spawnSync(process.execPath, ['--no-warnings', SYNC_SCRIPT], {
    input: bomPayload,
    env: baseEnv,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(bomRes.error, undefined);
  assert.equal(bomRes.status, 0, bomRes.stderr);
  assert.deepEqual(JSON.parse(bomRes.stdout.trim()), { decision: 'allow' });
  const csvPath = path.join(ledgerDir, 'bom-proj.csv');
  assert.equal(fs.existsSync(csvPath), true);
  assert.ok(fs.readFileSync(csvPath, 'utf8').includes('BOM Stop test'));

  // (b) Malformed/truncated Stop JSON still fails open with { decision: 'allow' }; non-Stop returns {}.
  for (const malformedStop of ['{"hookEventName":"Stop","broken":', '\uFEFF{"hookEventName" : "Stop", "x":']) {
    const res = spawnSync(process.execPath, ['--no-warnings', SYNC_SCRIPT], {
      input: malformedStop,
      env: baseEnv,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout.trim()), { decision: 'allow' });
  }
  const badStart = spawnSync(process.execPath, ['--no-warnings', SYNC_SCRIPT], {
    input: '{"hookEventName":"SessionStart","broken":',
    env: baseEnv,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(badStart.status, 0, badStart.stderr);
  assert.deepEqual(JSON.parse(badStart.stdout.trim()), {});

  // (c) Active .agy-band.lock timeout during Stop still exits 0 with { decision: 'allow' }.
  const lockPath = path.join(ledgerDir, '.agy-band.lock');
  fs.writeFileSync(lockPath, '99999\n', 'utf8');
  const lockedStop = spawnSync(process.execPath, ['--no-warnings', SYNC_SCRIPT], {
    input: JSON.stringify({
      hookEventName: 'Stop',
      conversationId: convId,
      workspacePaths: [repoDir],
      transcriptPath: tPath,
    }),
    env: { ...baseEnv, PONYTAIL_LOCK_TIMEOUT_MS: '40' },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(lockedStop.error, undefined);
  assert.equal(lockedStop.status, 0, lockedStop.stderr);
  assert.deepEqual(JSON.parse(lockedStop.stdout.trim()), { decision: 'allow' });
});

test('importAllBrains and CLI --import prune vanished cache entries per brain dir while preserving --project and sibling dirs', t => {
  const tmp = makeTmpDir('pw-agy-cache-prune-');
  const prevBrainEnv = process.env.PONYTAIL_AGY_BRAIN_DIRS;
  t.after(() => {
    if (prevBrainEnv === undefined) delete process.env.PONYTAIL_AGY_BRAIN_DIRS;
    else process.env.PONYTAIL_AGY_BRAIN_DIRS = prevBrainEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const ponytailDir = makePonytailFixture(tmp);
  const ledgerDir = path.join(tmp, 'band');
  const brainA = path.join(tmp, 'brain-a');
  const brainASibling = path.join(tmp, 'brain-a2');
  const repoAlpha = path.join(tmp, 'alpha');
  const repoBeta = path.join(tmp, 'beta');
  for (const r of [repoAlpha, repoBeta]) {
    fs.mkdirSync(r, { recursive: true });
    spawnSync('git', ['init', r], { stdio: 'ignore' });
  }

  const mkSession = (bDir, id, repo) => {
    const tPath = path.join(bDir, id, '.system_generated', 'logs', 'transcript.jsonl');
    writeJsonl(tPath, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:00:00Z', content: `Task ${id}` },
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-15T10:00:05Z', input_tokens: 100, cache_read_tokens: 0, output_tokens: 10, tool_calls: [{ name: 'read_file', args: { Path: JSON.stringify(path.join(repo, 'index.js')) } }] },
    ]);
  };

  const idA = '11111111-aaaa-1111-1111-111111111111';
  const idBeta = '22222222-bbbb-2222-2222-222222222222';
  const idSibling = '33333333-cccc-3333-3333-333333333333';
  mkSession(brainA, idA, repoAlpha);
  mkSession(brainA, idBeta, repoBeta);
  mkSession(brainASibling, idSibling, repoBeta);

  const cacheFile = path.join(ledgerDir, '.agy-import-cache.json');
  const readEntries = () => JSON.parse(fs.readFileSync(cacheFile, 'utf8')).entries;

  process.env.PONYTAIL_AGY_BRAIN_DIRS = `${brainA}${path.delimiter}${brainASibling}`;
  importAllBrains({ ledgerDir, ponytailDir, allowTempWorkspaces: true });
  assert.equal(Object.keys(readEntries()).length, 3);

  // (1) Partial --brain-dir scan keeps sibling brain-a2 entry (even if brain-a2 shares brain-a prefix) while pruning vanished idA.
  fs.rmSync(path.join(brainA, idA), { recursive: true, force: true });
  fs.rmSync(path.join(brainASibling, idSibling), { recursive: true, force: true });
  importAllBrains({ brainDirs: [brainA], ledgerDir, ponytailDir, allowTempWorkspaces: true });
  let entries = readEntries();
  assert.equal(Boolean(entries[idA]), false, 'vanished session in scanned brainA must be pruned');
  assert.equal(Boolean(entries[idBeta]), true);
  assert.equal(Boolean(entries[idSibling]), true, 'unscanned sibling brain-a2 must be preserved');
  assert.ok(fs.readFileSync(path.join(ledgerDir, 'alpha.csv'), 'utf8').includes(idA.slice(0, 8)), 'CSV row must remain intact');

  // (2) --project filtered CLI --import must preserve other projects/vanished entries.
  fs.rmSync(path.join(brainA, idBeta), { recursive: true, force: true });
  const projRes = spawnSync(
    process.execPath,
    ['--no-warnings', SYNC_SCRIPT, '--import', '--project', 'alpha', '--brain-dir', brainA, '--ledger-dir', ledgerDir, '--ponytail-dir', ponytailDir, '--json'],
    { env: { ...process.env, PONYTAIL_AGY_ALLOW_TEMP: '1' }, encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(projRes.status, 0, projRes.stderr);
  entries = readEntries();
  assert.equal(Boolean(entries[idBeta]), true, '--project filter must not prune cache entries');

  // (3) Full --import --force via PONYTAIL_AGY_BRAIN_DIRS when sessions.size === 0 rewrites entries: {}.
  const forceRes = spawnSync(
    process.execPath,
    ['--no-warnings', SYNC_SCRIPT, '--import', '--force', '--ledger-dir', ledgerDir, '--ponytail-dir', ponytailDir, '--json'],
    { env: { ...process.env, PONYTAIL_AGY_BRAIN_DIRS: `${brainA}${path.delimiter}${brainASibling}`, PONYTAIL_AGY_ALLOW_TEMP: '1' }, encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(forceRes.status, 0, forceRes.stderr);
  assert.equal(JSON.parse(forceRes.stdout.trim()).sessionsFound, 0);
  assert.deepEqual(readEntries(), {});
  assert.ok(fs.readFileSync(path.join(ledgerDir, 'beta.csv'), 'utf8').includes(idBeta.slice(0, 8)));
});

test('importAllBrains prunes expired absent-transcript .agy-sessions.json entries while preserving active, fresh, and scoped metadata', t => {
  const tmp = makeTmpDir('pw-agy-session-ttl-');
  const prevBrainEnv = process.env.PONYTAIL_AGY_BRAIN_DIRS;
  t.after(() => {
    if (prevBrainEnv === undefined) delete process.env.PONYTAIL_AGY_BRAIN_DIRS;
    else process.env.PONYTAIL_AGY_BRAIN_DIRS = prevBrainEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const ponytailDir = makePonytailFixture(tmp);
  const brainDir = path.join(tmp, 'brain');
  const ledgerDir = path.join(tmp, 'band');
  const repoDir = path.join(tmp, 'ttl-repo');
  fs.mkdirSync(repoDir, { recursive: true });
  spawnSync('git', ['init', repoDir], { stdio: 'ignore' });

  const activeId = 'aaaa1111-1111-1111-1111-111111111111';
  const activeTp = path.join(brainDir, activeId, '.system_generated', 'logs', 'transcript.jsonl');
  writeJsonl(activeTp, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-15T10:00:00Z', content: 'Active old' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-15T10:00:05Z', input_tokens: 100, cache_read_tokens: 0, output_tokens: 10, tool_calls: [{ name: 'read_file', args: { Path: JSON.stringify(path.join(repoDir, 'a.js')) } }] },
  ]);

  fs.mkdirSync(ledgerDir, { recursive: true });
  const sessionsPath = path.join(ledgerDir, '.agy-sessions.json');
  const now = Date.now();
  const staleId = 'bbbb2222-2222-2222-2222-222222222222';
  const corruptId = 'cccc3333-3333-3333-3333-333333333333';
  const freshHookId = 'dddd4444-4444-4444-4444-444444444444';
  fs.writeFileSync(
    sessionsPath,
    JSON.stringify({
      [activeId]: { cwd: repoDir, updatedAt: now - 60_000 },
      [staleId]: { cwd: repoDir, updatedAt: now - 60_000 },
      [corruptId]: { cwd: repoDir },
    }),
    'utf8',
  );
  handleHookPayload(
    { hookEventName: 'SessionStart', conversationId: freshHookId, workspacePaths: [repoDir], customLabel: 'Fresh Start' },
    { ledgerDir, ponytailDir, allowTempWorkspaces: true },
  );

  process.env.PONYTAIL_AGY_BRAIN_DIRS = brainDir;
  const readSessions = () => JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));

  // Partial scans (--project and explicit --brain-dir / options.brainDirs) must never prune .agy-sessions.json.
  importAllBrains({ ledgerDir, ponytailDir, allowTempWorkspaces: true, project: 'other', sessionMetaTtlMs: 5000 });
  assert.ok(readSessions()[staleId], '--project scan must leave .agy-sessions.json untouched');

  importAllBrains({ brainDirs: [brainDir], ledgerDir, ponytailDir, allowTempWorkspaces: true, sessionMetaTtlMs: 5000 });
  assert.ok(readSessions()[staleId], 'explicit options.brainDirs scan must leave .agy-sessions.json untouched');

  const cliPartial = spawnSync(
    process.execPath,
    ['--no-warnings', SYNC_SCRIPT, '--import', '--brain-dir', brainDir, '--ledger-dir', ledgerDir, '--ponytail-dir', ponytailDir, '--json'],
    { env: { ...process.env, PONYTAIL_AGY_ALLOW_TEMP: '1' }, encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(cliPartial.status, 0, cliPartial.stderr);
  assert.ok(readSessions()[staleId], 'CLI --brain-dir must leave .agy-sessions.json untouched');

  // Unfiltered default/env import prunes expired absent-transcript entries while preserving active-old and fresh SessionStart.
  importAllBrains({ ledgerDir, ponytailDir, allowTempWorkspaces: true, sessionMetaTtlMs: 5000 });
  const after = readSessions();
  assert.equal(Boolean(after[staleId]), false, 'expired absent-transcript entry should be pruned');
  assert.equal(Boolean(after[corruptId]), false, 'entry without valid updatedAt should be pruned');
  assert.ok(after[activeId], 'old entry whose transcript exists must be retained');
  assert.equal(after[freshHookId]?.customLabel, 'Fresh Start', 'fresh SessionStart entry within TTL must be retained');
});
