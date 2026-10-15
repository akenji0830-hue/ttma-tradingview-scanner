import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { withRecovery, permanentFailure, runScanner, validDelivery, saveDelivery, notifyFailure } from './reliability.mjs';
import { startBrowserWithSession, waitForChrome } from './tradingview-session.mjs';

test('temporary failures recover and are bounded at three attempts', async () => {
  let count = 0; const delays = [];
  assert.equal(await withRecovery(async () => { if (++count < 3) throw new Error('Temporary'); return 'ok'; },
    { pause: async (ms) => delays.push(ms) }), 'ok');
  assert.equal(count, 3); assert.deepEqual(delays, [5000, 10000]);
  count = 0;
  await assert.rejects(() => withRecovery(async () => { count++; throw new Error('Still unavailable'); }, { pause: async () => {} }), /Still unavailable/);
  assert.equal(count, 3);
});
test('credentials, permissions and budget failures are not retried indefinitely', async () => {
  for (const message of ['AUTH_REQUIRED', 'Missing SMTP_PASS', 'TradingView cookies expired', 'TradingView 尚未登入', 'Invalid login 535', 'BUDGET']) {
    let attempts = 0;
    await assert.rejects(() => withRecovery(async () => { attempts++; throw new Error(message); }, { pause: async () => {} }));
    assert.equal(attempts, 1); assert.equal(permanentFailure(new Error(message)), true);
  }
});

const cookies = Buffer.from(JSON.stringify([{ name: 'sessionid', value: 'fake-unit-test', domain: '.tradingview.com', expires: -1 }])).toString('base64');
test('Chrome startup retries twice then restores a session using fresh profiles', async () => {
  let starts = 0, stops = 0, profiles = 0, restored = 0;
  const stop = await startBrowserWithSession({ chromePath: 'chrome', profileDirectory: '/unused', port: 9224, encodedCookies: cookies }, {
    createProfile: async () => `/test/profile-${++profiles}`,
    spawnProcess: (_path, args) => {
      starts++; assert.ok(args.includes(`--user-data-dir=/test/profile-${profiles}`));
      assert.ok(!args.includes('--no-sandbox'));
      const child = new EventEmitter(); child.stderr = new EventEmitter(); return child;
    },
    waitForStartup: async () => { if (starts < 3) throw new Error('Headless Chrome did not start.'); },
    fetcher: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://fake' }) }),
    cdp: async (_url, method) => { assert.equal(method, 'Network.setCookies'); restored++; },
    stop: async () => { stops++; }, pause: async () => {},
  });
  assert.equal(starts, 3); assert.equal(stops, 2); assert.equal(restored, 1);
  await stop(); assert.equal(stops, 3);
});
test('expired auth session fails before launching Chrome even if preference cookies survive', async () => {
  const encodedCookies = Buffer.from(JSON.stringify([
    { name: 'sessionid', value: 'fake', domain: '.tradingview.com', expires: 1 },
    { name: 'language', value: 'zh', domain: '.tradingview.com', expires: -1 },
  ])).toString('base64');
  await assert.rejects(() => startBrowserWithSession({ encodedCookies }, { spawnProcess: () => { throw new Error('Must not spawn'); } }), /expired/);
});
test('Chrome wait allows more than the old 20 seconds but stops on crash', async () => {
  let time = 0;
  await waitForChrome(9224, { clock: () => time, pause: async (ms) => { time += ms; },
    fetcher: async () => ({ ok: time > 25000 }),
  });
  assert.ok(time > 20000 && time < 60000);
  await assert.rejects(() => waitForChrome(9224, { child: { exitCode: 1 }, fetcher: () => { throw new Error('No fetch'); } }), /exited/);
});

function child() {
  const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
  p.kill = () => { queueMicrotask(() => p.emit('close', null)); return true; }; return p;
}
test('scanner progress is relayed and a clean exit succeeds', async () => {
  const p = child(); const seen = [];
  const result = runScanner([], { spawnProcess: () => p, idleMs: 1000, timeoutMs: 2000, log: (s) => seen.push(String(s)) });
  p.stdout.emit('data', '[1/997] OK'); p.emit('close', 0);
  assert.equal((await result).code, 0); assert.deepEqual(seen, ['[1/997] OK']);
});
test('a silent stuck scanner is terminated instead of waiting forever', async () => {
  const p = child();
  await assert.rejects(() => runScanner([], { spawnProcess: () => p, idleMs: 10, timeoutMs: 1000 }), /no progress/);
});
test('overall attempt budget terminates a scanner even if output continues', async () => {
  const p = child();
  await assert.rejects(() => runScanner([], { spawnProcess: () => p, idleMs: 1000, timeoutMs: 10 }), /time budget/);
});
test('scanner authentication error survives to the recovery classifier', async () => {
  const p = child();
  const result = runScanner([], { spawnProcess: () => p, log: () => {} });
  p.stderr.emit('data', 'TradingView 尚未登入'); p.emit('close', 1);
  await assert.rejects(() => result, (error) => permanentFailure(error));
});
test('only a current-date accepted full audit can suppress a backup', async () => {
  const marker = { date: '2026-10-15', sent: true, stocks: 997, ok: 997, errors: 0 };
  assert.equal(validDelivery(marker, '2026-10-15'), true);
  for (const change of [{ date: '2026-10-14' }, { sent: false }, { stocks: 5 }, { ok: 0, errors: 997 }, { ok: 5 }, { ok: 1000, errors: -3 }, { ok: '997' }]) {
    assert.equal(validDelivery({ ...marker, ...change }, '2026-10-15'), false);
  }
});
test('a mail send without SMTP acceptance never creates a completion marker', async () => {
  await assert.rejects(() => saveDelivery('2026-10-15', { stocks: 997, ok: 997, errors: 0 }, { accepted: [] }), /did not accept/);
});
test('notifications are sent without needing Chrome, but not on a weekend', async () => {
  const sent = [];
  const options = { statusFn: async () => ({ allowed: true }), mailerFactory: async () => ({ sendMail: async (mail) => sent.push(mail), close: () => {} }) };
  await notifyFailure({ ...options, now: new Date('2026-10-15T15:00:00+08:00') });
  assert.equal(sent.length, 1); assert.match(sent[0].subject, /未完成/);
  await notifyFailure({ ...options, now: new Date('2026-10-18T15:00:00+08:00') });
  assert.equal(sent.length, 1);
});
test('run supervisor uses a persistent checkpoint and atomic scanner checkpoints', async () => {
  const source = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.match(source, /'--resume'/); assert.match(source, /attempts: 3/);
  assert.ok(source.indexOf('await createMailer()') < source.indexOf('await startBrowserWithSession('));
  const scanner = await readFile(new URL('../tradingview-signal-scanner.mjs', import.meta.url), 'utf8');
  assert.match(scanner, /await rename\(temporary, path\)/);
});
test('fallback and watchdog never require paid billing or expanded token permissions', async () => {
  const workflow = await readFile(new URL('../.github/workflows/scan.yml', import.meta.url), 'utf8');
  assert.match(workflow, /20 6 \* \* 1-5/);
  assert.match(workflow, /Report delivery confirmed/);
  assert.match(workflow, /contents: read/); assert.doesNotMatch(workflow, /actions: write|contents: write/);
  assert.match(workflow, /failure\(\) && env.MODE == 'full'/);
  assert.match(workflow, /cancel-in-progress: false/);
});
