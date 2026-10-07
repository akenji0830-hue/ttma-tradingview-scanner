// Retry only read-only observations. Never automatically repeat a click/input.
export function isNavigationContextError(error) {
  return /Cannot find default execution context|Execution context was destroyed|Cannot find context with specified id/i
    .test(error instanceof Error ? error.message : String(error));
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function evaluateReadOnlyWithRetry(session, expression, {
  timeoutMs = 30000, intervalMs = 250, clock = Date.now, sleep = pause,
} = {}) {
  const deadline = clock() + timeoutMs;
  let lastError;
  while (clock() < deadline) {
    try { return await session.evaluate(expression); }
    catch (error) {
      if (!isNavigationContextError(error)) throw error;
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error('TradingView browser context did not become ready before timeout.', { cause: lastError });
}

export async function waitForDocumentReady(session, {
  timeoutMs = 30000, intervalMs = 250, stablePolls = 2, clock = Date.now, sleep = pause,
} = {}) {
  const deadline = clock() + timeoutMs;
  let stable = 0;
  let previousHref;
  let lastError;
  while (clock() < deadline) {
    try {
      const page = await session.evaluate(
        "({ href: location.href, ready: document.readyState === 'complete', body: !!document.body })",
      );
      if (page?.ready && page.body && page.href && page.href !== 'about:blank') {
        stable = previousHref === page.href ? stable + 1 : 1;
        previousHref = page.href;
        if (stable >= stablePolls) return page;
      } else {
        stable = 0;
        previousHref = undefined;
      }
    } catch (error) {
      if (!isNavigationContextError(error)) throw error;
      lastError = error;
      stable = 0;
      previousHref = undefined;
    }
    await sleep(intervalMs);
  }
  throw new Error('TradingView page did not finish loading before timeout.', { cause: lastError });
}
