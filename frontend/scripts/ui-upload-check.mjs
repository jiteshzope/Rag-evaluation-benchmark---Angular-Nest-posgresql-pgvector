/**
 * Upload check: attaches real files to both pickers in the running UI and
 * asserts what the app makes of them, including the rows it skips.
 *
 * Usage: node scripts/ui-upload-check.mjs [appUrl] [screenshotDir] [fixtureDir]
 * Requires: the backend and the frontend dev server running.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { preflight } from './lib/preflight.mjs';

/**
 * Locates a Chromium binary to drive.
 *
 * These checks talk to the app over the DevTools Protocol — a plain WebSocket
 * that Node can open unaided — so no browser-automation dependency is needed.
 * Point BROWSER_BIN at any Chromium build to override the search.
 */
function findBrowser() {
  const candidates = [
    process.env.BROWSER_BIN,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error('No Chromium binary found. Set BROWSER_BIN to one.');
    process.exit(2);
  }
  return found;
}

const EDGE = findBrowser();
const APP = process.argv[2] ?? 'http://localhost:5173/';
const API_ORIGIN = process.argv[4] ?? 'http://localhost:3001';
const OUT = process.argv[3] ?? fileURLToPath(new URL('../../screenshots/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const FIXTURES = process.argv[4] ?? fileURLToPath(new URL('../../test-fixtures', import.meta.url));
const PORT = 9336;

const profile = mkdtempSync(join(tmpdir(), 'ragbench-up-'));
const edge = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--window-size=1400,1200',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 40 && !wsUrl; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = l.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch {
    /* not up */
  }
  if (!wsUrl) await sleep(250);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 1;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const { resolve, reject } = pend.get(m.id);
    pend.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
const send = (method, params = {}) => {
  const i = id++;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((resolve, reject) => pend.set(i, { resolve, reject }));
};
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
};

/** Attaches a real file to the nth matching <input type=file>, via the DOM domain. */
async function attachFile(accept, path) {
  const doc = await send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await send('DOM.querySelectorAll', {
    nodeId: doc.root.nodeId,
    selector: `input[type=file][accept*="${accept}"]`,
  });
  if (!nodeIds.length) return false;
  await send('DOM.setFileInputFiles', { nodeId: nodeIds[0], files: [path] });
  return true;
}

async function shot(name) {
  const m = await send('Page.getLayoutMetrics');
  const h = Math.min(Math.ceil(m.cssContentSize.height), 6000);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: h,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(350);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  await send('Emulation.clearDeviceMetricsOverride');
  console.log(`  shot: ${name}.png`);
}

let pass = 0,
  fail = 0;
const ok = (n, c, extra = '') => {
  c ? (pass++, console.log('  PASS ' + n)) : (fail++, console.log('  FAIL ' + n + '  ' + extra));
};

await send('Page.enable');
await send('DOM.enable');
await send('Runtime.enable');
await preflight(API_ORIGIN, 2, () => {
  ws.close();
  edge.kill();
});

await send('Page.navigate', { url: APP });
await sleep(9000);

console.log('\n== Upload a knowledge base file ==');
ok('kb file input found', await attachFile('.md', join(FIXTURES, 'mock-knowledge-base.md')));
await sleep(3000);
ok(
  'uploaded corpus accepted',
  await evaluate(`document.body.textContent.includes('mock-knowledge-base.md')`),
  await evaluate(
    `[...document.querySelectorAll('.notice')].map(n=>n.textContent.trim()).join(' | ').slice(0,200)`,
  ),
);
ok(
  'dataset step unlocked',
  await evaluate(`
  [...document.querySelectorAll('.option-card-locked h3')].map(h=>h.textContent.trim()).join() === 'Demo question set'
`),
);

console.log('\n== Upload a dataset file ==');
ok('dataset file input found', await attachFile('.jsonl', join(FIXTURES, 'mock-dataset.csv')));
await sleep(2500);
ok(
  'CSV parsed to 3 questions',
  await evaluate(`document.body.textContent.includes('3 questions ready')`),
);
ok(
  'run enabled',
  await evaluate(`
  !![...document.querySelectorAll('button')].find(b => b.textContent.includes('Run evaluation') && !b.disabled)
`),
);
await shot('09-uploaded-files');

console.log('\n== Skipped rows are surfaced ==');
ok(
  'messy dataset attached',
  await attachFile('.jsonl', join(FIXTURES, 'mock-dataset-messy.jsonl')),
);
await sleep(2500);
ok('2 valid rows kept', await evaluate(`document.body.textContent.includes('2 questions ready')`));
ok(
  'skipped rows reported',
  await evaluate(`document.body.textContent.includes('skipped')`),
  await evaluate(`document.body.textContent.match(/.{0,80}skipped.{0,80}/)?.[0] ?? 'no mention'`),
);
await shot('10-skipped-rows');

console.log(`\n---- UPLOAD: ${pass} passed, ${fail} failed ----`);
ws.close();
edge.kill();
process.exit(fail ? 1 : 0);
