/**
 * End-to-end run check: starts a real evaluation from the UI, watches the live
 * progress screen, then asserts every chart, table and drawer on the results
 * screen actually rendered.
 *
 * This is the check the charts need. They are hand-drawn SVG rather than a
 * charting library, so "the component mounted" proves nothing — the assertions
 * below look for real geometry: bar paths with a non-empty `d`, axis ticks,
 * legends, and a tooltip that appears under the pointer.
 *
 * Spends one run of daily quota and a little API credit.
 * Usage: node scripts/ui-run-check.mjs [appUrl] [screenshotDir] [apiOrigin]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Locates a Chromium binary to drive; set BROWSER_BIN to override. */
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
const OUT = process.argv[3] ?? fileURLToPath(new URL('../../screenshots/', import.meta.url));
const API_ORIGIN = process.argv[4] ?? 'http://localhost:3001';
mkdirSync(OUT, { recursive: true });
const PORT = 9338;

const profile = mkdtempSync(join(tmpdir(), 'ragbench-run-'));
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
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  } catch {
    /* not up yet */
  }
  if (!wsUrl) await sleep(250);
}
if (!wsUrl) {
  console.error('CDP never became available');
  edge.kill();
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let nextId = 1;
const pending = new Map();
const pageErrors = [];
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails.exception?.description ?? 'unknown error');
  }
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

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
}

async function shot(name) {
  const metrics = await send('Page.getLayoutMetrics');
  const h = Math.min(Math.ceil(metrics.cssContentSize.height), 8000);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: h,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(400);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  await send('Emulation.clearDeviceMetricsOverride');
  console.log(`  shot: ${name}.png (${h}px)`);
}

const waitFor = async (expression, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(500);
  }
  console.log(`  (timed out waiting for ${label})`);
  return false;
};

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

const finish = () => {
  console.log(`\n---- RUN: ${pass} passed, ${fail} failed ----`);
  if (pageErrors.length) {
    console.log('\nUncaught page errors:');
    for (const e of pageErrors) console.log('  ' + e.split('\n')[0]);
  }
  ws.close();
  edge.kill();
  process.exit(fail || pageErrors.length ? 1 : 0);
};

await send('Page.enable');
await send('Runtime.enable');

// A run is the scarce resource here, so check the budget before spending one.
const quotas = (await (await fetch(`${API_ORIGIN}/api/quotas`)).json()).quotas;
const runQuota = quotas.find((q) => q.action === 'run');
if (!runQuota || runQuota.remaining < 1) {
  console.error(`No run quota left (${runQuota?.remaining ?? '?'} of ${runQuota?.limit ?? '?'}).`);
  ws.close();
  edge.kill();
  process.exit(2);
}
console.log(`Run quota: ${runQuota.remaining} of ${runQuota.limit} left.`);

// ── 1. Set up the smallest possible real run ────────────────────────────────
console.log('\n== RUN 1: start an evaluation ==');
await send('Page.navigate', { url: APP });
ok(
  'demo pairing applied',
  await waitFor(`document.body.textContent.includes('questions ready')`, 30000, 'the demo pairing'),
);

// Five questions is the slider's minimum, which keeps the check cheap.
await evaluate(`
  (() => {
    const slider = document.getElementById('qcount');
    slider.value = '5';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    return slider.value;
  })()
`);
ok(
  'question count dropped to 5',
  await waitFor(`document.body.textContent.includes('5 questions ready')`, 25000, '5 questions'),
);

const strategyCount = await evaluate(`
  document.querySelectorAll('.option-card-selected h3').length
`);
ok('two strategies selected by default', strategyCount >= 2, `found ${strategyCount}`);

ok('run clicked', await clickByText('button', 'Run evaluation'));

// ── 2. The live progress screen ─────────────────────────────────────────────
console.log('\n== RUN 2: live progress ==');
ok(
  'progress screen shown',
  await waitFor(
    `document.body.textContent.includes('Running evaluation') || document.body.textContent.includes('Preparing')`,
    30000,
    'the progress screen',
  ),
);

ok('progress bar present', await evaluate(`!!document.querySelector('[role=progressbar]')`));
ok(
  'cancel offered',
  await evaluate(`
  !![...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel run')
`),
);

const perStrategyCards = await evaluate(`
  document.querySelectorAll('section.grid .step-section').length
`);
ok('a card per strategy', perStrategyCards >= 2, `found ${perStrategyCards}`);

ok(
  'results stream in live',
  await waitFor(`document.body.textContent.includes('Latest results')`, 240000, 'the first result'),
);

/**
 * The fill animates over 500ms and every streamed result restarts that
 * transition, so a single measurement lands mid-flight as often as not. Poll
 * for the width to reach the percentage the bar reports instead: a binding that
 * was wrong would never converge, however long this waited.
 */
const readBar = `
  (() => {
    const track = document.querySelector('[role=progressbar]');
    const fill = track?.firstElementChild;
    if (!track || !fill) return null;
    return {
      claimed: Number(track.getAttribute('aria-valuenow')),
      actual: (fill.getBoundingClientRect().width / track.getBoundingClientRect().width) * 100,
    };
  })()
`;
let bar = null;
for (let i = 0; i < 40; i++) {
  bar = await evaluate(readBar);
  if (bar && Math.abs(bar.actual - Math.max(2, bar.claimed)) < 1.5) break;
  await sleep(150);
}
ok(
  'the bar fills to the percentage it reports',
  bar && Math.abs(bar.actual - Math.max(2, bar.claimed)) < 1.5,
  JSON.stringify(bar),
);
await shot('11-run-progress');

// ── 3. Results ──────────────────────────────────────────────────────────────
console.log('\n== RUN 3: results ==');
ok(
  'results screen reached',
  await waitFor(
    `[...document.querySelectorAll('h1')].some((h) => h.textContent.trim() === 'Results')`,
    420000,
    'the run to finish',
  ),
);
await sleep(1500);

ok(
  'trade-off table rendered',
  await evaluate(`
  document.body.textContent.includes('Quality against cost and latency')
`),
);
ok(
  'strategy tabs rendered',
  await evaluate(`
  document.querySelectorAll('[role=tab]').length >= 2
`),
);

// Every chart is hand-drawn SVG, so check for real geometry rather than a mount.
const charts = await evaluate(`
  [...document.querySelectorAll('app-bar-chart')].map((c) => ({
    bars: [...c.querySelectorAll('path')].filter((p) => (p.getAttribute('d') || '').length > 10).length,
    ticks: c.querySelectorAll('text').length,
    gridLines: c.querySelectorAll('.chart-grid line').length,
  }))
`);
ok('every chart present', charts.length >= 7, `found ${charts.length}`);
ok(
  'every chart drew bars',
  charts.every((c) => c.bars > 0),
  JSON.stringify(charts),
);
ok(
  'every chart drew axis ticks',
  charts.every((c) => c.ticks > 0),
  JSON.stringify(charts),
);
ok(
  'every chart drew a grid',
  charts.every((c) => c.gridLines > 0),
  JSON.stringify(charts),
);

ok(
  'legends rendered',
  await evaluate(`
  document.querySelectorAll('app-chart-legend li').length >= 10
`),
);
ok(
  'table views offered',
  await evaluate(`
  [...document.querySelectorAll('details summary')].filter((s) => s.textContent.includes('View as table')).length >= 6
`),
);

// The relief rule: the same numbers must be readable without colour.
await evaluate(`
  document.querySelectorAll('details').forEach((d) => { d.open = true; });
`);
await sleep(400);
ok(
  'table views hold numbers',
  await evaluate(`
  document.querySelectorAll('app-data-table tbody tr').length >= 6
`),
);
await evaluate(`document.querySelectorAll('details').forEach((d) => { d.open = false; })`);

ok(
  'metric tiles rendered',
  await evaluate(`
  document.querySelectorAll('app-stat-tile').length >= 15
`),
);
ok(
  'composite score is a number',
  await evaluate(`
  /^\\d\\.\\d{3}$/.test(
    [...document.querySelectorAll('app-stat-tile')]
      .find((t) => t.textContent.includes('Composite'))
      ?.querySelector('p.tabular-nums')?.textContent.trim() ?? ''
  )
`),
);

// Tooltip: hover the middle of the first chart's plot area.
const hovered = await evaluate(`
  (() => {
    const svg = document.querySelector('app-bar-chart svg');
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 };
  })()
`);
if (hovered) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hovered.x, y: hovered.y });
  await sleep(300);
  ok(
    'tooltip follows the pointer',
    await evaluate(`
    !![...document.querySelectorAll('app-bar-chart div')].find((d) => d.className.includes('pointer-events-none'))
  `),
  );
} else {
  ok('tooltip follows the pointer', false, 'no chart svg to hover');
}

ok(
  'question table populated',
  await evaluate(`
  document.querySelectorAll('app-question-results-table tbody tr').length >= 5
`),
);
await shot('12-results');

// ── 4. Sorting, filtering and the detail drawer ─────────────────────────────
console.log('\n== RUN 4: the per-question explorer ==');
const beforeSort = await evaluate(`
  [...document.querySelectorAll('app-question-results-table tbody tr')].map((r) => r.textContent.slice(0, 40))
`);
await clickByText('app-question-results-table th button', 'nDCG');
await sleep(400);
const afterSort = await evaluate(`
  [...document.querySelectorAll('app-question-results-table tbody tr')].map((r) => r.textContent.slice(0, 40))
`);
ok('sorting reorders the rows', JSON.stringify(beforeSort) !== JSON.stringify(afterSort));

await evaluate(`
  (() => {
    const select = [...document.querySelectorAll('app-question-results-table select')]
      .find((s) => s.getAttribute('aria-label') === 'Filter by strategy');
    if (!select) return false;
    select.value = select.options[1].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()
`);
await sleep(400);
const filteredStrategies = await evaluate(`
  new Set([...document.querySelectorAll('app-question-results-table tbody tr td:nth-child(2)')]
    .map((c) => c.textContent.trim())).size
`);
ok(
  'strategy filter narrows to one',
  filteredStrategies === 1,
  `found ${filteredStrategies} distinct`,
);

await evaluate(`
  (() => {
    const select = [...document.querySelectorAll('app-question-results-table select')]
      .find((s) => s.getAttribute('aria-label') === 'Filter by strategy');
    select.value = 'all';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()
`);
await sleep(300);

ok(
  'row opened',
  await evaluate(`
  (() => {
    const row = document.querySelector('app-question-results-table tbody tr');
    if (!row) return false;
    row.click();
    return true;
  })()
`),
);
await sleep(600);

const drawer = await evaluate(`
  (() => {
    const d = document.querySelector('[role=dialog]');
    if (!d) return null;
    const text = d.textContent;
    return {
      metrics: text.includes('Reciprocal rank') && text.includes('nDCG@5'),
      answers: text.includes('Generated answer') && text.includes('Reference answer'),
      trace: text.includes('Retrieval pipeline'),
      context: text.includes('Retrieved context'),
      cost: text.includes('Cost and latency'),
      chunks: d.querySelectorAll('ol li').length,
    };
  })()
`);
ok('drawer opened', !!drawer);
ok('drawer shows metrics', drawer?.metrics, JSON.stringify(drawer));
ok('drawer shows both answers', drawer?.answers);
ok('drawer shows the pipeline trace', drawer?.trace);
ok(
  'drawer shows retrieved context',
  drawer?.context && drawer.chunks > 0,
  `${drawer?.chunks} list items`,
);
ok('drawer shows cost and latency', drawer?.cost);
await shot('13-question-drawer');

await send('Input.dispatchKeyEvent', {
  type: 'keyDown',
  key: 'Escape',
  code: 'Escape',
  windowsVirtualKeyCode: 27,
});
await sleep(400);
ok('escape closes the drawer', await evaluate(`!document.querySelector('[role=dialog]')`));

finish();
