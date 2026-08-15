/**
 * Setup-flow check: walks the real UI through the demo pairing, a pasted
 * corpus, a pasted dataset and a reset, asserting the lock behaves in both
 * directions and screenshotting each state.
 *
 * Usage: node scripts/ui-flow-check.mjs [appUrl] [screenshotDir]
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
const URL_BASE = process.argv[2] ?? 'http://localhost:5173/';
const API_ORIGIN = process.argv[4] ?? 'http://localhost:3001';
const OUT = process.argv[3] ?? fileURLToPath(new URL('../../screenshots/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const PORT = 9333;

const profile = mkdtempSync(join(tmpdir(), 'ragbench-cdp-'));
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

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('CDP never became available');
}

const ws = new WebSocket(await target());
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/** Evaluates an expression in the page and returns its JSON value. */
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
}

async function shot(name) {
  const metrics = await send('Page.getLayoutMetrics');
  const h = Math.min(Math.ceil(metrics.cssContentSize.height), 6000);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: h,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(300);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  await send('Emulation.clearDeviceMetricsOverride');
  console.log(`  shot: ${name}.png (${h}px)`);
}

/** Clicks the first element whose text matches, returning whether it hit. */
const clickByText = (selector, text) =>
  evaluate(`
  (() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((n) => n.textContent.trim().includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  })()
`);

/**
 * Waits for a page predicate to hold.
 *
 * These checks run against a remote API, so a fixed sleep is a race: the demo
 * corpus and question set take three sequential round-trips to apply, and how
 * long that is depends on the network rather than on anything the app does.
 */
const waitFor = async (expression, timeoutMs = 25000, label = expression) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(250);
  }
  console.log(`  (timed out waiting for ${label})`);
  return false;
};

const textOf = (selector) =>
  evaluate(`
  [...document.querySelectorAll(${JSON.stringify(selector)})].map((n) => n.textContent.trim())
`);

let pass = 0,
  fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  PASS ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + '  ' + extra);
  }
};

await send('Page.enable');
await send('Runtime.enable');

await preflight(API_ORIGIN, 1, () => {
  ws.close();
  edge.kill();
});

// ── 1. Default workflow, and the lock it implies ────────────────────────────
console.log('\n== UI 1: demo knowledge base locks the question source ==');
await send('Page.navigate', { url: URL_BASE });
await waitFor(
  `document.body.textContent.includes('questions ready')`,
  25000,
  'the demo pairing to apply',
);

ok(
  'setup screen rendered',
  (await textOf('h1')).some((t) => t.includes('Configure an evaluation')),
);

const lockedCount = await evaluate(`document.querySelectorAll('.option-card-locked').length`);
ok('three dataset options are locked', lockedCount === 3, `found ${lockedCount}`);

const lockNotice = await evaluate(`
  [...document.querySelectorAll('.notice')].some((n) => n.textContent.includes('demo question set'))
`);
ok('lock is explained in a notice', lockNotice);

const disabledInputs = await evaluate(`
  ({
    uploadBtn: !![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Choose dataset file') && b.disabled),
    pasteBtn: !![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Use this dataset') && b.disabled),
    pasteArea: !![...document.querySelectorAll('textarea')].find((t) => t.disabled),
  })
`);
ok('dataset upload button disabled', disabledInputs.uploadBtn);
ok('dataset paste button disabled', disabledInputs.pasteBtn);
ok('dataset textarea disabled', disabledInputs.pasteArea);

const defaultReady = await evaluate(`document.body.textContent.includes('20 questions ready')`);
ok('demo question set applied automatically', defaultReady);
ok(
  'no bogus cap warning',
  !(await evaluate(`document.body.textContent.includes('Capped at 100 questions')`)),
);
ok(
  'sample line shown instead',
  await evaluate(`document.body.textContent.includes('Sampled 20 of 150')`),
);

await shot('01-default-locked');

// ── 2. Switching to a pasted corpus unlocks the dataset step ────────────────
console.log('\n== UI 2: pasted knowledge base unlocks the question sources ==');
const kbText = (await import('node:fs')).readFileSync(
  new URL('../../test-fixtures/mock-knowledge-base.md', import.meta.url),
  'utf8',
);

await clickByText('h3', 'Paste text');
await sleep(400);
await evaluate(`
  (() => {
    const ta = [...document.querySelectorAll('textarea')]
      .find((t) => t.placeholder.includes('knowledge base text'));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(kbText)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value.length;
  })()
`);
await sleep(300);
ok('paste applied', await clickByText('button', 'Use this text'));
await waitFor(
  `[...document.querySelectorAll('.notice')].some((n) => n.textContent.includes('ready ·'))
     && !document.body.textContent.includes('Assurio Health')`,
  25000,
  'the pasted corpus to be accepted',
);

ok(
  'pasted corpus is ready',
  await evaluate(
    `document.body.textContent.includes('northwind') || document.body.textContent.includes('pasted-text')`,
  ),
  (await textOf('.notice')).join(' | ').slice(0, 160),
);

// The lock inverts: your own three sources open up, the demo set closes.
const lockTitles = await evaluate(`
  [...document.querySelectorAll('.option-card-locked h3')].map((h) => h.textContent.trim())
`);
ok(
  'only the demo question set stays locked',
  lockTitles.length === 1 && lockTitles[0] === 'Demo question set',
  JSON.stringify(lockTitles),
);
ok(
  'own dataset controls are enabled',
  await evaluate(`
  !![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Choose dataset file') && !b.disabled)
`),
);
ok(
  'demo question set explains why',
  await evaluate(`
  document.body.textContent.includes('Available only with the demo knowledge base')
`),
);

await shot('02-pasted-unlocked');

// ── 3. Paste a dataset against it ───────────────────────────────────────────
console.log('\n== UI 3: pasted dataset ==');
const dsText = (await import('node:fs')).readFileSync(
  new URL('../../test-fixtures/mock-dataset.jsonl', import.meta.url),
  'utf8',
);

await clickByText('h3', 'Paste a dataset');
await sleep(300);
await evaluate(`
  (() => {
    const ta = [...document.querySelectorAll('textarea')]
      .find((t) => (t.placeholder || '').includes('reference_answer'));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(dsText)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(300);
await clickByText('button', 'Use this dataset');
await waitFor(
  `document.body.textContent.includes('6 questions ready')`,
  25000,
  'the pasted dataset',
);

ok(
  '6 questions accepted',
  await evaluate(`document.body.textContent.includes('6 questions ready')`),
);
ok(
  'run step is enabled',
  await evaluate(`
  !![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Run evaluation') && !b.disabled)
`),
);
await shot('03-paste-dataset-ready');

// ── 4. Start over ───────────────────────────────────────────────────────────
console.log('\n== UI 4: start over ==');
ok('start over clicked', await clickByText('button', 'Start over'));
await waitFor(
  `document.body.textContent.includes('20 questions ready')`,
  25000,
  'the demo pairing to come back',
);

ok('back to the demo corpus', await evaluate(`document.body.textContent.includes('Assurio')`));
ok(
  'back to the demo question set',
  await evaluate(`document.body.textContent.includes('20 questions ready')`),
);
ok(
  'dataset options locked again',
  (await evaluate(`document.querySelectorAll('.option-card-locked').length`)) === 3,
);
ok(
  'pasted text cleared',
  await evaluate(`
  [...document.querySelectorAll('textarea')].every((t) => t.value === '')
`),
);
await shot('04-after-reset');

console.log(`\n---- UI: ${pass} passed, ${fail} failed ----`);
ws.close();
edge.kill();
process.exit(fail ? 1 : 0);
