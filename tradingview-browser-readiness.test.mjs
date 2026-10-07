import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { evaluateReadOnlyWithRetry, isNavigationContextError, waitForDocumentReady } from './tradingview-browser-readiness.mjs';

const ready = (href = 'https://tw.tradingview.com/chart/NTBWgRFB/') => ({ href, ready: true, body: true });
function harness(values) {
  let calls = 0;
  let time = 0;
  return {
    session: { evaluate: async () => {
      const value = values[Math.min(calls++, values.length - 1)];
      if (value instanceof Error) throw value;
      return value;
    } },
    options: { timeoutMs: 1000, intervalMs: 100, clock: () => time, sleep: async (ms) => { time += ms; } },
    calls: () => calls,
  };
}

for (const message of ['Cannot find default execution context',
  'Execution context was destroyed.', 'Cannot find context with specified id']) {
  test(`recovers from navigation: ${message}`, async () => {
    const h = harness([new Error(message), ready(), ready()]);
    assert.equal((await waitForDocumentReady(h.session, h.options)).href, ready().href);
    assert.equal(h.calls(), 3);
  });
}

test('requires complete document/body and ignores initial about:blank', async () => {
  const h = harness([{ href: 'about:blank', ready: true, body: true },
    { ...ready(), ready: false }, { ...ready(), body: false }, ready(), ready()]);
  await waitForDocumentReady(h.session, h.options);
  assert.equal(h.calls(), 5);
});

test('a redirect resets the stability requirement', async () => {
  const h = harness([ready('https://tw.tradingview.com/'), ready(), ready()]);
  await waitForDocumentReady(h.session, h.options);
  assert.equal(h.calls(), 3);
});

test('context loss after an apparently ready page resets stability', async () => {
  const h = harness([ready(), new Error('Cannot find default execution context'), ready(), ready()]);
  await waitForDocumentReady(h.session, h.options);
  assert.equal(h.calls(), 4);
});

test('permanently unavailable context has a bounded failure', async () => {
  const h = harness([new Error('Cannot find default execution context')]);
  await assert.rejects(() => waitForDocumentReady(h.session, h.options), /before timeout/);
  assert.equal(h.calls(), 10);
});

test('permanently loading document has a bounded failure', async () => {
  const h = harness([{ ...ready(), ready: false }]);
  await assert.rejects(() => waitForDocumentReady(h.session, h.options), /before timeout/);
  assert.equal(h.calls(), 10);
});

test('read-only URL evaluation retries transient context loss', async () => {
  const h = harness([new Error('Cannot find default execution context'), ready().href]);
  assert.equal(await evaluateReadOnlyWithRetry(h.session, 'location.href', h.options), ready().href);
  assert.equal(h.calls(), 2);
});

test('read-only URL retry also respects its deadline', async () => {
  const h = harness([new Error('Execution context was destroyed')]);
  await assert.rejects(() => evaluateReadOnlyWithRetry(h.session, 'location.href', h.options), /before timeout/);
});

test('real script/permission/connection errors are not masked or retried', async () => {
  for (const message of ['ReferenceError: missing is not defined', 'Access denied', 'Chrome connection closed']) {
    const h = harness([new Error(message), ready()]);
    await assert.rejects(() => waitForDocumentReady(h.session, h.options), { message });
    assert.equal(h.calls(), 1);
    assert.equal(isNavigationContextError(new Error(message)), false);
  }
});

test('startup waits for a stable document before returning the session', async () => {
  const source = await readFile(new URL('./tradingview-signal-scanner.mjs', import.meta.url), 'utf8');
  const openSession = source.slice(source.indexOf('async function openSession'), source.indexOf('async function waitForPage'));
  assert.ok(openSession.indexOf('await waitForPage(session)') < openSession.indexOf('return session'));
  assert.match(openSession, /session.close\(\)/);
  // Click/input evaluation retains the original non-retrying behavior.
  const evaluate = source.slice(source.indexOf('async evaluate(expression)'), source.indexOf('close()'));
  assert.doesNotMatch(evaluate, /evaluateReadOnlyWithRetry|waitForDocumentReady/);
});
