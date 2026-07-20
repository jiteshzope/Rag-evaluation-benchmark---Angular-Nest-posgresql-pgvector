/**
 * API contract check for the setup → dataset → run workflows.
 *
 * Exercises every path the setup screen can take against a running backend,
 * including the ones the UI is supposed to make unreachable — the server has to
 * refuse them on its own, not because the buttons were greyed out.
 *
 * Usage: node scripts/api-contract-check.mjs [fixtureDir] [baseUrl]
 * Requires: the backend running (npm run dev:backend).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = (process.argv[3] ?? 'http://localhost:3001') + '/api';
const MOCK = process.argv[2] ?? fileURLToPath(new URL('../test-fixtures', import.meta.url));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  ' + extra); }
};

async function call(method, path, body, form) {
  const init = { method };
  if (form) init.body = form;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const r = await fetch(BASE + path, init);
  let j = null;
  try { j = await r.json(); } catch { /* empty body */ }
  return { status: r.status, body: j };
}

function fileForm(path, name, type) {
  const f = new FormData();
  f.append('file', new Blob([readFileSync(path)], { type }), name);
  return f;
}

const short = (v, n = 180) => JSON.stringify(v).slice(0, n);

// ── Preflight ───────────────────────────────────────────────────────────────
// The suite spends real upload quota. Without this check an exhausted budget
// shows up as a dozen unrelated assertion failures instead of one clear reason.
const NEEDED = { upload: 5, generate: 0, run: 0 };
{
  let meta;
  try {
    meta = await call('GET', '/meta');
  } catch (err) {
    console.error(`Cannot reach the API at ${BASE}. Start it with "npm run dev:backend".`);
    process.exit(2);
  }
  if (meta.status === 404 || !meta.body?.quotas) {
    console.error(`Unexpected response from ${BASE}/meta.`);
    process.exit(2);
  }
  const tight = meta.body.quotas.filter((q) => q.remaining < NEEDED[q.action]);
  if (tight.length) {
    console.error('\nNot enough daily quota left to run this suite:');
    for (const q of tight) console.error(`  ${q.action}: ${q.remaining} left, needs ${NEEDED[q.action]}`);
    console.error('\nRestart the backend to clear the in-memory quota, then re-run.');
    process.exit(2);
  }
  if (!meta.body.defaultKnowledgeBase || !meta.body.defaultDataset) {
    console.error('The demo corpus or question set is not loaded; the default-pairing checks cannot run.');
    process.exit(2);
  }
  console.log(`API up — pgvector ${meta.body.pgvector.available ? 'seeded' : 'NOT seeded'}, ` +
    `demo corpus ${meta.body.defaultKnowledgeBase.documentCount} docs, ` +
    `${meta.body.defaultDataset.questionCount} demo questions.`);
}

console.log('\n== A. Experiment creation guards ==');
{
  const r = await call('POST', '/experiments', { strategies: ['baseline'], useDefaultDataset: true });
  ok('default dataset without default KB is rejected', r.status === 400, short(r.body));

  const r2 = await call('POST', '/experiments', {
    strategies: ['baseline'], useDefaultKnowledgeBase: true, useDefaultDataset: true, questionCount: 5,
  });
  ok('default KB + default dataset accepted', r2.status === 201 || r2.status === 200, short(r2.body));
  ok('  -> 5 questions loaded', r2.body?.dataset?.questionCount === 5, short(r2.body?.dataset));
  ok('  -> dataset source is default', r2.body?.dataset?.source === 'default');
  ok('  -> KB is the demo corpus',
    r2.body?.knowledgeBase?.source === 'default' && r2.body?.knowledgeBase?.documentCount === 76);

  const r3 = await call('POST', '/experiments', { strategies: ['nonsense'] });
  ok('unknown strategy rejected', r3.status === 400, short(r3.body));

  const r4 = await call('POST', '/experiments', {
    strategies: ['baseline', 'advanced', 'advanced-pro', 'graphrag'],
  });
  ok('over-limit strategy count rejected', r4.status === 400, short(r4.body));
}

console.log('\n== B. Default question set sampling ==');
{
  const e = (await call('POST', '/experiments', { strategies: ['baseline'], useDefaultKnowledgeBase: true })).body;
  const d1 = await call('POST', `/experiments/${e.id}/dataset/default?count=15`);
  ok('count=15 honoured', d1.body?.dataset?.questionCount === 15, short(d1.body?.dataset));
  const types = d1.body?.dataset?.byType?.map((t) => t.questionType) ?? [];
  ok('  -> spread across question types', types.length >= 5, types.join(','));

  const d2 = await call('POST', `/experiments/${e.id}/dataset/default?count=500`);
  ok('count above maxQuestions clamps to 100', d2.body?.dataset?.questionCount === 100, short(d2.body?.dataset));

  const d3 = await call('POST', `/experiments/${e.id}/dataset/default?count=abc`);
  ok('non-numeric count rejected', d3.status === 400, short(d3.body));

  const items = (await call('GET', `/experiments/${e.id}/dataset`)).body;
  ok('items carry reference answers + keywords',
    items?.items?.length === 100 &&
    items.items.every((i) => i.question && i.referenceAnswer && Array.isArray(i.expectedKeywords)));

}

console.log('\n== B2. Default corpus <-> default question set lock ==');
{
  // Default questions must not attach to someone else's corpus.
  const e = (await call('POST', '/experiments', { strategies: ['baseline'] })).body;
  await call('POST', `/experiments/${e.id}/knowledge-base/text`, {
    text: readFileSync(MOCK + '/mock-knowledge-base.md', 'utf8'), title: 'northwind',
  });
  const bad = await call('POST', `/experiments/${e.id}/dataset/default?count=5`);
  ok('default questions rejected on an uploaded corpus', bad.status === 400,
    'got ' + bad.status + ': ' + short(bad.body, 160));

  // …and the demo corpus must not run against someone else's questions.
  const d = (await call('POST', '/experiments', { strategies: ['baseline'], useDefaultKnowledgeBase: true })).body;
  const paste = await call('POST', `/experiments/${d.id}/dataset`, {
    content: readFileSync(MOCK + '/mock-dataset.jsonl', 'utf8'),
  });
  ok('pasted questions rejected on the demo corpus', paste.status === 400,
    'got ' + paste.status + ': ' + short(paste.body, 160));

  const up = await call('POST', `/experiments/${d.id}/dataset/upload`, undefined,
    fileForm(MOCK + '/mock-dataset.json', 'dataset.json', 'application/json'));
  ok('uploaded questions rejected on the demo corpus', up.status === 400, 'got ' + up.status);

  const gen = await call('POST', `/experiments/${d.id}/dataset/generate`, { count: 5 });
  ok('generation rejected on the demo corpus', gen.status === 400, 'got ' + gen.status + ': ' + short(gen.body, 120));
  const genQuota = (await call('GET', '/quotas')).body.quotas.find((q) => q.action === 'generate');
  ok('  -> rejected generation refunded its quota', genQuota.used === 0, JSON.stringify(genQuota));

  // Switching the corpus clears questions that no longer apply to it.
  const s = (await call('POST', '/experiments', {
    strategies: ['baseline'], useDefaultKnowledgeBase: true, useDefaultDataset: true, questionCount: 5,
  })).body;
  ok('starts with 5 default questions', s.dataset?.questionCount === 5);
  await call('POST', `/experiments/${s.id}/knowledge-base/text`, {
    text: readFileSync(MOCK + '/mock-knowledge-base.md', 'utf8'), title: 'northwind',
  });
  const after = (await call('GET', `/experiments/${s.id}`)).body;
  ok('switching to an uploaded corpus drops the default questions', after.dataset === null,
    short(after.dataset));
}

console.log('\n== C. Pasted knowledge base ==');
{
  const e = (await call('POST', '/experiments', { strategies: ['baseline'] })).body;
  const tooShort = await call('POST', `/experiments/${e.id}/knowledge-base/text`, { text: 'too short' });
  ok('sub-minimum text rejected', tooShort.status === 400, short(tooShort.body, 160));

  const good = await call('POST', `/experiments/${e.id}/knowledge-base/text`, {
    text: readFileSync(MOCK + '/mock-knowledge-base.md', 'utf8'), title: 'northwind',
  });
  ok('valid paste accepted', good.status === 201 || good.status === 200, short(good.body, 160));
  ok('  -> source=upload, chars recorded',
    good.body?.knowledgeBase?.source === 'upload' && good.body?.knowledgeBase?.totalChars > 2000,
    short(good.body?.knowledgeBase));
}

console.log('\n== D. Uploaded knowledge base ==');
{
  const e = (await call('POST', '/experiments', { strategies: ['baseline'] })).body;
  const bad = await call('POST', `/experiments/${e.id}/knowledge-base`, undefined,
    fileForm(MOCK + '/mock-dataset.csv', 'notes.csv', 'text/csv'));
  ok('unsupported extension rejected', bad.status === 400, short(bad.body, 140));

  const good = await call('POST', `/experiments/${e.id}/knowledge-base`, undefined,
    fileForm(MOCK + '/mock-knowledge-base.md', 'northwind-handbook.md', 'text/markdown'));
  ok('.md upload accepted', good.status === 201 || good.status === 200, short(good.body, 160));
  ok('  -> label is the filename', good.body?.knowledgeBase?.label === 'northwind-handbook.md');
}

console.log('\n== E. Dataset formats ==');
for (const [file, name, expect] of [['mock-dataset.jsonl', 'JSONL', 6], ['mock-dataset.json', 'JSON', 3], ['mock-dataset.csv', 'CSV', 3]]) {
  const e = (await call('POST', '/experiments', { strategies: ['baseline'] })).body;
  const r = await call('POST', `/experiments/${e.id}/dataset/upload`, undefined,
    fileForm(MOCK + '/' + file, file, 'text/plain'));
  ok(name + ' upload -> ' + expect + ' questions', r.body?.dataset?.questionCount === expect, short(r.body));
}
{
  const e = (await call('POST', '/experiments', { strategies: ['baseline'] })).body;
  const r = await call('POST', `/experiments/${e.id}/dataset`, {
    content: readFileSync(MOCK + '/mock-dataset.jsonl', 'utf8'),
  });
  ok('paste JSONL -> 6 questions', r.body?.dataset?.questionCount === 6, short(r.body));
  ok('  -> source=paste', r.body?.dataset?.source === 'paste');

  const e2 = (await call('POST', '/experiments', { strategies: ['baseline'] })).body;
  const m = await call('POST', `/experiments/${e2.id}/dataset`, {
    content: readFileSync(MOCK + '/mock-dataset-messy.jsonl', 'utf8'),
  });
  ok('messy dataset keeps the 2 valid rows', m.body?.dataset?.questionCount === 2, short(m.body?.dataset));
  ok('  -> bad rows reported as skipped', (m.body?.dataset?.skipped?.length ?? 0) >= 2, short(m.body?.dataset?.skipped));

  const e3 = (await call('POST', '/experiments', { strategies: ['baseline'] })).body;
  const junk = await call('POST', `/experiments/${e3.id}/dataset`, { content: 'complete garbage, no structure' });
  ok('unparseable dataset rejected', junk.status === 400, 'got ' + junk.status);
}

console.log('\n== F. Run preconditions and quota accounting ==');
{
  const runsBefore = (await call('GET', '/quotas')).body.quotas.find((q) => q.action === 'run').used;

  const e = (await call('POST', '/experiments', { strategies: ['baseline'] })).body;
  const r = await call('POST', `/experiments/${e.id}/run`);
  ok('run without a knowledge base rejected', r.status === 400, short(r.body, 140));

  const e2 = (await call('POST', '/experiments', { strategies: ['baseline'], useDefaultKnowledgeBase: true })).body;
  const r2 = await call('POST', `/experiments/${e2.id}/run`);
  ok('run without a dataset rejected', r2.status === 400, short(r2.body, 140));

  const runsAfter = (await call('GET', '/quotas')).body.quotas.find((q) => q.action === 'run').used;
  ok('rejected runs cost no run quota', runsAfter === runsBefore, `used ${runsBefore} -> ${runsAfter}`);

  const uploadsBefore = (await call('GET', '/quotas')).body.quotas.find((q) => q.action === 'upload').used;
  const e3 = (await call('POST', '/experiments', { strategies: ['baseline'] })).body;
  await call('POST', `/experiments/${e3.id}/knowledge-base/text`, { text: 'far too short' });
  const uploadsAfter = (await call('GET', '/quotas')).body.quotas.find((q) => q.action === 'upload').used;
  ok('rejected paste costs no upload quota', uploadsAfter === uploadsBefore, `used ${uploadsBefore} -> ${uploadsAfter}`);

  const miss = await call('GET', '/experiments/does-not-exist');
  ok('unknown experiment id -> 404', miss.status === 404, 'got ' + miss.status);
}

console.log('\n== F2. Changing the strategy selection after setup ==');
{
  const e = (await call('POST', '/experiments', {
    strategies: ['baseline'], useDefaultKnowledgeBase: true, useDefaultDataset: true, questionCount: 5,
  })).body;

  const patched = await call('PATCH', `/experiments/${e.id}/strategies`, {
    strategies: ['advanced', 'graphrag'],
  });
  ok('selection can be changed after creation', patched.status === 200, short(patched.body));
  ok('  -> server holds the new selection',
    JSON.stringify((await call('GET', `/experiments/${e.id}`)).body.strategies) ===
      JSON.stringify(['advanced', 'graphrag']));

  const dupes = await call('PATCH', `/experiments/${e.id}/strategies`, {
    strategies: ['baseline', 'baseline'],
  });
  ok('  -> duplicates collapse', JSON.stringify(dupes.body?.strategies) === JSON.stringify(['baseline']));

  const empty = await call('PATCH', `/experiments/${e.id}/strategies`, { strategies: [] });
  ok('empty selection rejected', empty.status === 400, short(empty.body, 120));

  const tooMany = await call('PATCH', `/experiments/${e.id}/strategies`, {
    strategies: ['baseline', 'advanced', 'advanced-pro', 'graphrag'],
  });
  ok('over-limit selection rejected', tooMany.status === 400, short(tooMany.body, 120));

  const unknown = await call('PATCH', `/experiments/${e.id}/strategies`, { strategies: ['nope'] });
  ok('unknown strategy rejected', unknown.status === 400, short(unknown.body, 120));
}

console.log('\n== F3. Error messages say what to do ==');
{
  const newExp = async () =>
    (await call('POST', '/experiments', { strategies: ['baseline'] })).body.id;

  const messageFor = async (content) =>
    (await call('POST', `/experiments/${await newExp()}/dataset`, { content })).body?.message ?? '';

  const missingQuestion = await messageFor(JSON.stringify([{ reference_answer: 'A' }]));
  ok('a row with no question names the accepted field spellings',
    /"question", "query", "prompt" or "input"/.test(missingQuestion), missingQuestion);
  ok('  -> and points at the line', /line 1/.test(missingQuestion), missingQuestion);

  const missingAnswer = await messageFor(JSON.stringify([{ question: 'Q?' }]));
  ok('a row with no answer names the accepted field spellings',
    /"reference_answer", "answer" or "expected_answer"/.test(missingAnswer), missingAnswer);

  // Valid JSON with the wrong fields must not be reported as a syntax error.
  const wrongFields = await messageFor('{"foo":1}\n{"bar":2}');
  ok('valid JSON with wrong fields is not blamed on JSON syntax',
    !/could be read as JSON/i.test(wrongFields), wrongFields);

  const notJson = await messageFor('{nope\n{also nope');
  ok('input that really is not JSON says so', /could be read as JSON/i.test(notJson), notJson);

  const gone = await call('POST', '/experiments/00000000-0000-0000-0000-000000000000/dataset', {
    content: '[]',
  });
  ok('an expired session explains itself without an internal id',
    gone.status === 404 && /session has expired/i.test(gone.body?.message ?? '') &&
      !/00000000-0000/.test(gone.body?.message ?? ''),
    short(gone.body, 200));
}

console.log('\n== G. Delete / reset ==');
{
  const e = (await call('POST', '/experiments', {
    strategies: ['baseline'], useDefaultKnowledgeBase: true, useDefaultDataset: true, questionCount: 5,
  })).body;
  const del = await call('DELETE', `/experiments/${e.id}`);
  ok('delete returns ok', del.status === 200 && del.body?.deleted === true, short(del.body));
  const after = await call('GET', `/experiments/${e.id}`);
  ok('deleted experiment is gone', after.status === 404, 'got ' + after.status);
}

console.log('\n---- ' + pass + ' passed, ' + fail + ' failed ----');
process.exit(fail ? 1 : 0);
