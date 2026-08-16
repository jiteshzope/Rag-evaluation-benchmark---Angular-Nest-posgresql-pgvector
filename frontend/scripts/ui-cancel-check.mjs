/**
 * Mid-run reset check: starts a real evaluation, hits "Start over" while it is
 * in flight, and asserts the confirm appears, the run is cancelled server-side
 * and the setup screen comes back clean.
 *
 * Spends one run of daily quota and a little API credit.
 * Usage: node scripts/ui-cancel-check.mjs [appUrl] [screenshotDir] [apiUrl]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

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
mkdirSync(OUT, { recursive: true });
const API = process.argv[4] ?? 'http://localhost:3001/api';
const PORT = 9337;

const profile = mkdtempSync(join(tmpdir(), 'ragbench-cancel-'));
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
let dialogSeen = null;
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogSeen = m.params.message;
    ws.send(
      JSON.stringify({ id: id++, method: 'Page.handleJavaScriptDialog', params: { accept: true } }),
    );
  }
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m.result);
    pend.delete(m.id);
  }
});
const send = (method, params = {}) => {
  const i = id++;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((r) => pend.set(i, r));
};
const evaluate = async (e) =>
  (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))
    .result.value;
const clickByText = (sel, text) =>
  evaluate(`
  (() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .find(n => n.textContent.trim().includes(${JSON.stringify(text)}));
    if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()
`);

let pass = 0,
  fail = 0;
const ok = (n, c, x = '') => {
  c ? (pass++, console.log('  PASS ' + n)) : (fail++, console.log('  FAIL ' + n + '  ' + x));
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: APP });
await sleep(9000);

// A larger question count gives time to interrupt.
await evaluate(`
  (() => { const s = document.getElementById('qcount');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(s, '25'); s.dispatchEvent(new Event('input', { bubbles: true })); })()
`);
await sleep(2500);

await clickByText('button', 'Run evaluation');
await sleep(6000);
ok('run in flight', await evaluate(`document.body.textContent.includes('Running evaluation')`));

await clickByText('button', 'Start over');
await sleep(1200);
ok('confirm dialog shown before discarding the run', Boolean(dialogSeen), String(dialogSeen));
ok('  dialog explains the run is not refunded', /not refunded/i.test(dialogSeen ?? ''));

await sleep(3500);
ok(
  'landed back on setup',
  await evaluate(`document.body.textContent.includes('Configure an evaluation')`),
);
ok(
  'demo pairing restored',
  await evaluate(`document.body.textContent.includes('20 questions ready')`),
);

// The backend should wind down: the run was cancelled, not orphaned. The loop
// only checks the cancel flag between questions, so give it a question's worth
// of time rather than asserting on the instant.
let active = -1;
for (let i = 0; i < 20; i++) {
  active = (await (await fetch(API + '/meta')).json()).activeRuns;
  if (active === 0) break;
  await sleep(2000);
}
ok('no run left running on the server', active === 0, `activeRuns=${active}`);

const m = await send('Page.getLayoutMetrics');
const h = Math.min(Math.ceil(m.cssContentSize.height), 6000);
await send('Emulation.setDeviceMetricsOverride', {
  width: 1400,
  height: h,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(300);
const { data } = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(OUT, '11-after-midrun-reset.png'), Buffer.from(data, 'base64'));

console.log(`\n---- CANCEL: ${pass} passed, ${fail} failed ----`);
ws.close();
edge.kill();
process.exit(fail ? 1 : 0);
