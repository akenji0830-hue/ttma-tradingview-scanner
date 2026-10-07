import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chooseDataWindowAction, createReadinessGate, isTriggered, parseReadinessSnapshot, runWithSafeFallback } from "./tradingview-readiness.mjs";
import { evaluateReadOnlyWithRetry, waitForDocumentReady } from "./tradingview-browser-readiness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0] ?? "help";

// User-requested exclusions apply to every source and every retry pass.
const excludedSymbols = new Set(["TPEX:5371", "TWSE:2867", "TPEX:5236"]);
function eligibleStocks(stocks) {
  return stocks.filter((stock) => !excludedSymbols.has(stock.tradingViewSymbol));
}

function option(name, fallback = null) {
  const prefix = `${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  return fallback;
}

function flag(name) {
  return argv.includes(name);
}

function positiveInteger(name, fallback) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必須是正整數`);
  return value;
}

const chartUrl = option(
  "--chart-url",
  process.env.TV_SIGNAL_CHART_URL ?? "https://tw.tradingview.com/chart/NTBWgRFB/",
);
const chromePort = Number(option("--chrome-port", process.env.TV_SIGNAL_CHROME_PORT ?? "9224"));
const chromePath = option(
  "--chrome-path",
  process.env.TV_SIGNAL_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
);
const profileDirectory = resolve(
  option(
    "--profile-dir",
    process.env.TV_SIGNAL_PROFILE_DIR ?? resolve(process.env.LOCALAPPDATA ?? here, "TTMA", "TradingViewSignalScanner"),
  ),
);
const reportDirectory = resolve(option("--output-dir", resolve(here, "reports")));
const defaultInputPath = resolve(here, "reports", "top1000-turnover-latest.csv");
const inputPath = resolve(option("--input", defaultInputPath));
const maxSymbols = Number(option("--max-symbols", "0"));
const switchTimeoutMs = positiveInteger("--timeout-ms", 15_000);
const delayMs = positiveInteger("--delay-ms", 750);
// TradingView may update the chart identity before the private indicator data
// has finished syncing. A short settle period avoids unnecessary safe fallbacks.
const fastSettleMs = positiveInteger("--fast-settle-ms", 1_200);
const maxPasses = positiveInteger("--passes", 3);
const fromWatchlist = flag("--watchlist");
const resume = flag("--resume");
const debug = flag("--debug");
const switchMode = option("--switch-mode", "url");
const speed = option("--speed", "safe").toLowerCase();

if (!["safe", "fast"].includes(speed)) throw new Error("--speed 必須是 safe 或 fast");
if (speed === "fast" && switchMode !== "url") throw new Error("快速模式必須使用 url 換股");

if (!Number.isInteger(chromePort) || chromePort < 1024 || chromePort > 65535) {
  throw new Error("--chrome-port 必須是 1024 到 65535 的整數");
}
if (!Number.isInteger(maxSymbols) || maxSymbols < 0) {
  throw new Error("--max-symbols 必須是 0 或正整數");
}

class ScannerError extends Error {
  constructor(message, details = null) {
    super(message);
    this.details = details;
  }
}

class CdpSession {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(webSocketUrl);
  }

  async connect() {
    await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(new Error("Chrome 連線逾時")), 10_000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolvePromise();
      }, { once: true });
      this.socket.addEventListener("error", () => {
        clearTimeout(timeout);
        rejectPromise(new Error("無法連線 Chrome"));
      }, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "頁面操作失敗");
    }
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

const sleep = (duration) => new Promise((resolvePromise) => setTimeout(resolvePromise, duration));

function pageFunction(fn, ...args) {
  return `(${fn.toString()})(...${JSON.stringify(args)})`;
}

async function waitForChrome() {
  const endpoint = `http://127.0.0.1:${chromePort}/json/version`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response.json();
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new ScannerError("Chrome 啟動逾時");
}

async function ensureChrome(initialUrl) {
  await mkdir(profileDirectory, { recursive: true });
  try {
    await waitForChrome();
  } catch {
    const child = spawn(chromePath, [
      `--remote-debugging-port=${chromePort}`,
      `--user-data-dir=${profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      initialUrl,
    ], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    await waitForChrome();
  }
}

async function browserTargets() {
  const response = await fetch(`http://127.0.0.1:${chromePort}/json/list`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new ScannerError("無法讀取 Chrome 分頁");
  return response.json();
}

async function createTarget(url) {
  const response = await fetch(
    `http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT", signal: AbortSignal.timeout(5_000) },
  );
  if (!response.ok) throw new ScannerError("無法建立 TradingView 分頁");
  return response.json();
}

async function openSession(url, { reuseChart = true } = {}) {
  await ensureChrome(url);
  const targets = await browserTargets();
  const chartPath = (() => {
    try { return new URL(chartUrl).pathname; } catch { return "/chart/"; }
  })();
  const existing = reuseChart
    ? targets.find((target) => target.type === "page" &&
      /tradingview\.com$/i.test(new URL(target.url).hostname) &&
      new URL(target.url).pathname.startsWith(chartPath))
    : null;
  const target = existing ?? await createTarget(url);
  const session = new CdpSession(target.webSocketDebuggerUrl);
  try {
    await session.connect();
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("DOM.enable");
    await session.send("Page.bringToFront");
    // A newly created page may not have its default JS context yet, or the
    // first redirect may destroy it. Wait before making any chart/UI reads.
    await waitForPage(session);
    return session;
  } catch (error) {
    session.close();
    throw error;
  }
}

async function waitForPage(session, timeoutMs = 30_000) {
  await waitForDocumentReady(session, { timeoutMs });
}

async function navigate(session, url) {
  await session.send("Page.navigate", { url });
  await waitForPage(session);
  await sleep(1_500);
}

async function ensureChartPage(session) {
  const currentUrl = await evaluateReadOnlyWithRetry(session, "location.href");
  let current;
  let expected;
  try {
    current = new URL(currentUrl);
    expected = new URL(chartUrl);
  } catch {
    await navigate(session, chartUrl);
    return;
  }
  if (current.hostname === expected.hostname && current.pathname === expected.pathname) {
    // Preserve the user's loaded layout, selected symbol and watchlist. Reloading TradingView can
    // temporarily blank the chart and the virtualized watchlist on slower/basic-plan sessions.
    await sleep(350);
    return;
  }
  await navigate(session, chartUrl);
}

async function waitUntil(check, timeoutMs, errorMessage, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue) return lastValue;
    await sleep(intervalMs);
  }
  throw new ScannerError(errorMessage, lastValue);
}

async function moveMouseOutsideChart(session) {
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 500,
    y: 20,
    buttons: 0,
  });
  await sleep(180);
}

async function clickPoint(session, point) {
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved", x: point.x, y: point.y, buttons: 0,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1,
  });
}

async function selectAllText(session) {
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17,
  });
}

async function pressTextKey(session, character) {
  const upper = character.toUpperCase();
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: upper,
    code: `Key${upper}`,
    text: upper,
    unmodifiedText: upper,
    windowsVirtualKeyCode: upper.charCodeAt(0),
    nativeVirtualKeyCode: upper.charCodeAt(0),
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: upper,
    code: `Key${upper}`,
    windowsVirtualKeyCode: upper.charCodeAt(0),
    nativeVirtualKeyCode: upper.charCodeAt(0),
  });
}

async function pressEnter(session) {
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

async function loginRequired(session) {
  return session.evaluate(pageFunction(() =>
    /accounts\/(?:signin|login)/i.test(location.href) ||
    /登入 TradingView|Sign in to TradingView/i.test(document.body?.innerText ?? ""),
  ));
}

async function chartIdentity(session) {
  return session.evaluate(pageFunction(() => {
    const labels = [...document.querySelectorAll("[aria-label]")]
      .map((element) => element.getAttribute("aria-label") ?? "");
    for (const label of labels) {
      const match = label.match(/\b(TWSE|TPEX):(\d{4})、[^\n]*的圖表/i) ??
        label.match(/\b(TWSE|TPEX):(\d{4}).*chart/i);
      if (match) return { market: match[1].toUpperCase(), code: match[2] };
    }
    const title = document.title ?? "";
    const code = title.match(/^\s*(\d{4})\b/)?.[1] ?? null;
    return code ? { market: null, code } : null;
  }));
}

async function ensureDataWindow(session) {
  const action = await waitUntil(() => session.evaluate(pageFunction(() => {
    const visible = (element) => Boolean(element && element.getClientRects().length);
    const label = (element) => [
      element.textContent,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const buttons = [...document.querySelectorAll("button, [role='button']")].filter(visible);
    const sideButton = buttons.find((element) => /物件樹和數據視窗|Object Tree and Data Window/i.test(label(element)));
    if (!sideButton) return null;
    const dataTab = [...document.querySelectorAll("[role='tab'], button")]
      .filter(visible)
      .find((element) => /^(數據視窗|Data Window)$/i.test(label(element)));
    if (dataTab) {
      dataTab.click();
      return "clicked-tab";
    }
    sideButton.click();
    return "clicked-panel";
  })), 12_000, "找不到 TradingView 的『物件樹和數據視窗』按鈕，圖表可能尚未載入");

  await sleep(350);
  await session.evaluate(pageFunction(() => {
    const visible = (element) => Boolean(element && element.getClientRects().length);
    const dataTab = [...document.querySelectorAll("[role='tab'], button")]
      .filter(visible)
      .find((element) => /^(數據視窗|Data Window)$/i.test([
        element.textContent,
        element.getAttribute?.("aria-label"),
      ].filter(Boolean).join(" ").trim()));
    dataTab?.click();
  }));

  await waitUntil(
    () => session.evaluate(pageFunction(() => /🔥 S Alpha/.test(document.body?.innerText ?? ""))),
    18_000,
    "數據視窗裡找不到『🔥 S Alpha』。請確認圖表已載入 tTMA ST 指標，且帳號仍有使用權限",
  );
}

function normalizeMarket(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "TW" || normalized === "TWSE") return "TWSE";
  if (["TWO", "TPEX", "OTC"].includes(normalized)) return "TPEX";
  return normalized;
}

async function readSignalData(session) {
  return session.evaluate(pageFunction(() => {
    const text = document.body?.innerText ?? "";
    const zh = text.lastIndexOf("日期\n");
    const en = text.lastIndexOf("Date\n");
    const start = Math.max(zh, en);
    if (start < 0) return null;
    const block = text.slice(start, start + 2_800);
    const match = block.match(/(?:日期|Date)\n([^\n]+)[\s\S]*?🔥 S Alpha\n([^\n]+)\n🟢 L1\n([^\n]+)/);
    if (!match) return null;
    const identity = block.match(/\n(\d{4})\s*·[^\n]*·\s*(TWSE|TPEX)\n/i);
    const date = match[1].match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? match[1].trim();
    return {
      code: identity?.[1] ?? null,
      market: identity?.[2]?.toUpperCase() ?? null,
      dataDate: date,
      sAlphaRaw: match[2].trim(),
      l1Raw: match[3].trim(),
    };
  }));
}

async function switchSymbol(session, stock) {
  const current = await chartIdentity(session);
  if (switchMode === "url") {
    if (current?.code === stock.code && (!current.market || current.market === stock.market)) {
      const currentData = await readSignalData(session);
      if (currentData?.code === stock.code && (!currentData.market || currentData.market === stock.market)) return;
    }
    const targetUrl = new URL(chartUrl);
    targetUrl.searchParams.set("symbol", stock.tradingViewSymbol);
    const currentUrl = await session.evaluate("location.href");
    if (currentUrl === targetUrl.href) {
      await session.send("Page.reload", { ignoreCache: false });
      await waitForPage(session);
      await sleep(2_500);
    } else {
      await navigate(session, targetUrl.href);
      await sleep(1_000);
    }
    await session.send("Page.bringToFront");
    await waitUntil(async () => {
      const identity = await chartIdentity(session);
      return identity?.code === stock.code && (!identity.market || identity.market === stock.market);
    }, switchTimeoutMs, `載入 ${stock.tradingViewSymbol} 圖表逾時`);
    await sleep(delayMs);
    return;
  }

  if (current?.code === stock.code && (!current.market || current.market === stock.market)) return;

  let symbolButton = null;
  if (switchMode === "keyboard") {
    const chartPoint = await session.evaluate(pageFunction(() => {
      const visible = (element) => Boolean(element && element.getClientRects().length);
      const region = [...document.querySelectorAll("[role='region']")]
        .filter(visible)
        .find((element) => /圖表|chart/i.test(element.getAttribute("aria-label") ?? ""));
      if (!region) return null;
      const rect = region.getBoundingClientRect();
      return { x: rect.left + rect.width * 0.55, y: rect.top + rect.height * 0.48 };
    }));
    if (!chartPoint) throw new ScannerError("找不到 TradingView 主圖表區域");
    if (debug) console.log(`\n[debug] chartPoint ${JSON.stringify(chartPoint)}`);
    await clickPoint(session, chartPoint);
    await pressTextKey(session, "T");
  } else {
    symbolButton = await session.evaluate(pageFunction((currentCode) => {
    const visible = (element) => Boolean(element && element.getClientRects().length);
    const buttons = [...document.querySelectorAll("button")].filter(visible);
    const chartButton = buttons.find((element) => /^(變更商品|Change symbol)$/i.test(element.getAttribute("aria-label") ?? ""));
    const exact = buttons.find((element) => element.textContent?.trim() === currentCode);
    const fallback = buttons.find((element) => /^\d{4}$/.test(element.textContent?.trim() ?? ""));
    const target = chartButton ?? exact ?? fallback;
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text: target.textContent?.trim() ?? "",
      ariaLabel: target.getAttribute("aria-label"),
      className: String(target.className).slice(0, 240),
      // TradingView's current React control ignores HTMLElement.click() in
      // automation. Return its coordinates and send a real pointer click.
      directClicked: false,
    };
    }, current?.code ?? ""));
    if (!symbolButton) throw new ScannerError("找不到圖表左上角的股票代碼按鈕");
    if (debug) console.log(`\n[debug] symbolButton ${JSON.stringify(symbolButton)}`);
    if (!symbolButton.directClicked) await clickPoint(session, symbolButton);
  }

  const searchBox = await waitUntil(
    () => session.evaluate(pageFunction(() => {
      const input = document.querySelector("[role='dialog'] input[role='searchbox'], [role='dialog'] input[type='search'], [role='dialog'] input");
      if (!input || !input.getClientRects().length) return null;
      const rect = input.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })),
    5_000,
    "TradingView 商品搜尋視窗沒有開啟",
  );
  await clickPoint(session, searchBox);
  await selectAllText(session);
  await session.send("Input.insertText", { text: stock.tradingViewSymbol });
  await sleep(450);
  let searchState = await session.evaluate(pageFunction(() => {
    const dialog = document.querySelector("[role='dialog']");
    const input = dialog?.querySelector("input[role='searchbox'], input[type='search'], input");
    return {
      value: input?.value ?? "",
      text: (dialog?.innerText ?? "").replace(/\s+/g, " ").slice(0, 1_500),
    };
  }));
  if (searchState.value !== stock.tradingViewSymbol) {
    await session.evaluate(pageFunction((symbol) => {
      const input = document.querySelector("[role='dialog'] input[role='searchbox'], [role='dialog'] input[type='search'], [role='dialog'] input");
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, symbol);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: symbol }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, stock.tradingViewSymbol));
    await sleep(450);
    searchState = await session.evaluate(pageFunction(() => {
      const dialog = document.querySelector("[role='dialog']");
      const input = dialog?.querySelector("input[role='searchbox'], input[type='search'], input");
      return { value: input?.value ?? "", text: (dialog?.innerText ?? "").replace(/\s+/g, " ").slice(0, 1_500) };
    }));
  }
  if (debug) console.log(`\n[debug] search ${JSON.stringify(searchState)}`);
  if (searchState.value !== stock.tradingViewSymbol) {
    throw new ScannerError(`商品搜尋框內容錯誤：${searchState.value || "空白"}`);
  }
  await pressEnter(session);

  await waitUntil(async () => {
    const identity = await chartIdentity(session);
    if (debug) console.log(`[debug] identity ${JSON.stringify(identity)}`);
    return identity?.code === stock.code && (!identity.market || identity.market === stock.market);
  }, switchTimeoutMs, `切換到 ${stock.tradingViewSymbol} 逾時`);
  await sleep(900);
  const stableIdentity = await chartIdentity(session);
  if (stableIdentity?.code !== stock.code || (stableIdentity.market && stableIdentity.market !== stock.market)) {
    throw new ScannerError(`切換到 ${stock.tradingViewSymbol} 後又回到 ${stableIdentity?.market ?? ""}:${stableIdentity?.code ?? "未知"}`);
  }
  await sleep(delayMs);
}

async function navigateFreshSymbol(session, stock) {
  const before = (await session.send("Page.getFrameTree")).frameTree.frame;
  const targetUrl = new URL(chartUrl);
  targetUrl.searchParams.set("symbol", stock.tradingViewSymbol);
  const navigation = await session.send("Page.navigate", { url: targetUrl.href });
  if (navigation.errorText) throw new ScannerError(`圖表導航失敗：${navigation.errorText}`);
  // A missing loaderId means a same-document navigation. Explicitly reload so the
  // previous symbol's complete document cannot satisfy the readiness checks.
  if (!navigation.loaderId) await session.send("Page.reload", { ignoreCache: false });
  const frame = await waitUntil(async () => {
    const current = (await session.send("Page.getFrameTree")).frameTree.frame;
    const fresh = navigation.loaderId
      ? current.loaderId === navigation.loaderId && current.loaderId !== before.loaderId
      : current.loaderId && current.loaderId !== before.loaderId;
    return fresh ? current : null;
  }, switchTimeoutMs, `${stock.tradingViewSymbol} 尚未進入新的圖表頁面`, 150);
  await session.send("Page.bringToFront");
  return { frameId: frame.id, loaderId: frame.loaderId };
}

async function prepareDataWindowFast(session, state, controls) {
  const requestedAction = chooseDataWindowAction(controls, state, Date.now());
  if (!requestedAction) return;
  const action = await session.evaluate(pageFunction((requested) => {
    const visible = (element) => Boolean(element && element.getClientRects().length);
    const label = (element) => [element.textContent, element.getAttribute?.("aria-label"), element.getAttribute?.("title")]
      .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const bodyText = document.body?.innerText ?? "";
    const dateStart = Math.max(bodyText.lastIndexOf("日期\n"), bodyText.lastIndexOf("Date\n"));
    const dataBlock = dateStart >= 0 ? bodyText.slice(dateStart, dateStart + 2_800) : "";
    if (dataBlock.includes("🔥 S Alpha\n") && dataBlock.includes("🟢 L1\n")) return "";
    const buttons = [...document.querySelectorAll("button, [role='button'], [role='tab']")].filter(visible);
    const dataTab = buttons.find((element) => /^(數據視窗|Data Window)$/i.test(label(element)));
    if (requested === "tab" && dataTab) {
      dataTab.click();
      return "tab";
    }
    const sideButton = buttons.find((element) => /物件樹和數據視窗|Object Tree and Data Window/i.test(label(element)));
    const active = ["aria-pressed", "data-active", "aria-expanded"].map((attribute) => sideButton?.getAttribute(attribute));
    if (requested === "panel" && !dataTab && sideButton && !active.includes("true") && active.includes("false")) {
      sideButton.click();
      return "panel";
    }
    return "";
  }, requestedAction));
  if (action === "tab") state.lastTabClickAt = Date.now();
  if (action === "panel") {
    state.lastPanelClickAt = Date.now();
    state.panelClicks = (state.panelClicks ?? 0) + 1;
  }
}

async function readReadinessRaw(session) {
  return session.evaluate(pageFunction(() => {
    const visible = (element) => Boolean(element && element.getClientRects().length);
    const charts = [...document.querySelectorAll("[aria-label]")].filter((element) => {
      const label = element.getAttribute("aria-label") ?? "";
      return /\b(?:TWSE|TPEX):\d{4}\b/.test(label) && /圖表|chart/i.test(label) && visible(element);
    });
    const bodyText = document.body?.innerText ?? "";
    const dateStart = Math.max(bodyText.lastIndexOf("日期\n"), bodyText.lastIndexOf("Date\n"));
    const dataBlock = dateStart >= 0 ? bodyText.slice(dateStart, dateStart + 2_800) : "";
    const label = (element) => [element.textContent, element.getAttribute?.("aria-label"), element.getAttribute?.("title")]
      .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const controls = [...document.querySelectorAll("button, [role='button'], [role='tab']")];
    const dataTab = controls.find((element) => /^(數據視窗|Data Window)$/i.test(label(element)) && visible(element));
    const sideButton = controls.find((element) => /物件樹和數據視窗|Object Tree and Data Window/i.test(label(element)) && visible(element));
    return {
      bodyText,
      dataWindowText: dataBlock,
      url: location.href,
      title: document.title,
      chartLabels: charts.map((element) => element.getAttribute("aria-label")),
      readyState: document.readyState,
      busy: charts.some((chart) => chart.getAttribute("aria-busy") === "true" ||
        [...chart.querySelectorAll("[aria-busy='true'], [role='progressbar']")].some(visible)),
      controls: {
        hasDateBlock: dateStart >= 0,
        hasSignalBlock: dataBlock.includes("🔥 S Alpha\n") && dataBlock.includes("🟢 L1\n"),
        dataTabFound: Boolean(dataTab),
        dataTabLabel: dataTab ? label(dataTab) : null,
        dataTabAriaSelected: dataTab?.getAttribute("aria-selected") ?? null,
        dataTabDataActive: dataTab?.getAttribute("data-active") ?? null,
        sideButtonFound: Boolean(sideButton),
        sideButtonLabel: sideButton ? label(sideButton) : null,
        sideAriaPressed: sideButton?.getAttribute("aria-pressed") ?? null,
        sideDataActive: sideButton?.getAttribute("data-active") ?? null,
        sideAriaExpanded: sideButton?.getAttribute("aria-expanded") ?? null,
      },
    };
  }));
}

async function readStableSignals(session, stock, { guard = null, fastPanel = false } = {}) {
  const deadline = Date.now() + switchTimeoutMs;
  const gate = createReadinessGate(stock);
  const panelState = {};
  let lastIssue = "尚未讀到 tTMA";
  let lastControls = null;
  while (Date.now() < deadline) {
    try {
      let documentMatches = true;
      if (guard) {
        const frame = (await session.send("Page.getFrameTree")).frameTree.frame;
        documentMatches = frame.id === guard.frameId && frame.loaderId === guard.loaderId;
      }
      const raw = await readReadinessRaw(session);
      lastControls = raw.controls;
      if (documentMatches && fastPanel) await prepareDataWindowFast(session, panelState, raw.controls);
      const snapshot = parseReadinessSnapshot(raw);
      const result = gate(snapshot, Date.now(), { documentMatches, pointerMoved: true });
      if (result.ready) return result.data;
      lastIssue = result.issue;
    } catch (error) {
      // Navigation can destroy an execution context between polling calls.
      // Reset stability, but propagate unrelated errors to the fallback path.
      if (!/context.*destroy|Cannot find context|Inspected target navigated|Cannot find default execution context/i.test(error.message ?? "")) throw error;
      gate(null, Date.now(), { documentMatches: false });
      lastIssue = "圖表正在切換頁面";
    }
    await sleep(150);
  }
  if (debug) console.log(`\n[debug] readiness-controls ${JSON.stringify(lastControls)}`);
  throw new ScannerError(`${stock.tradingViewSymbol} 資料未就緒：${lastIssue}`, lastControls);
}

async function diagnoseReadiness() {
  // Diagnostic inspection only: never launch, navigate, focus, or open panels.
  const expected = new URL(chartUrl);
  const target = (await browserTargets()).find((item) => {
    try {
      const url = new URL(item.url);
      return item.type === "page" && url.hostname === expected.hostname && url.pathname === expected.pathname;
    } catch { return false; }
  });
  if (!target) throw new ScannerError("沒有已開啟的掃描器圖表，診斷不會自動開啟或切换圖表");
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.connect();
  try {
    const raw = await readReadinessRaw(session);
    const symbolControls = await session.evaluate(pageFunction(() => {
      const visible = (element) => Boolean(element && element.getClientRects().length);
      return [...document.querySelectorAll("button, [role='button'], [role='combobox'], [data-name]")]
        .filter(visible)
        .map((element) => ({
          tag: element.tagName,
          text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
          aria: element.getAttribute("aria-label"),
          title: element.getAttribute("title"),
          name: element.getAttribute("data-name"),
        }))
        .filter((item) => /商品|symbol|\b\d{4}\b|search/i.test([item.text, item.aria, item.title, item.name].filter(Boolean).join(" ")))
        .slice(0, 80);
    }));
    console.log(JSON.stringify({
      title: target.title,
      url: target.url,
      readyState: raw.readyState,
      chartLabels: raw.chartLabels,
      controls: raw.controls,
      symbolControls,
      dataWindowText: raw.dataWindowText,
      parsed: parseReadinessSnapshot(raw),
    }, null, 2));
  } finally {
    session.close();
  }
}

async function scanOneFast(session, stock) {
  const guard = await navigateFreshSymbol(session, stock);
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 500, y: 20, buttons: 0 });
  await sleep(fastSettleMs);
  return readStableSignals(session, stock, { guard, fastPanel: true });
}

async function scanOneSafe(session, stock, { forceFresh = false } = {}) {
  let guard = null;
  if (forceFresh) {
    guard = await navigateFreshSymbol(session, stock);
    await waitForPage(session);
    await sleep(2_500 + delayMs);
  } else {
    await switchSymbol(session, stock);
  }
  await ensureDataWindow(session);
  await moveMouseOutsideChart(session);
  return readStableSignals(session, stock, { guard });
}

async function scanOne(session, stock) {
  const startedAt = Date.now();
  let result;
  try {
    result = speed === "fast"
      // If the fast URL navigation is not ready, retry through the normal
      // symbol-switch flow. Reusing a forced fresh navigation here can repeat
      // the same TradingView synchronization race and create false errors.
      ? await runWithSafeFallback(() => scanOneFast(session, stock), () => scanOneSafe(session, stock, { forceFresh: false }))
      : { data: await scanOneSafe(session, stock), modeUsed: "safe", fallbackReason: "" };
  } catch (error) {
    error.elapsedMs = Date.now() - startedAt;
    error.modeUsed ??= speed;
    throw error;
  }
  const { data, modeUsed, fallbackReason } = result;
  return {
    status: "OK",
    signal: [
      isTriggered(data.sAlphaRaw) ? "S_ALPHA" : null,
      isTriggered(data.l1Raw) ? "L1" : null,
    ].filter(Boolean).join("+"),
    code: stock.code,
    name: stock.name ?? "",
    market: stock.market,
    tradingViewSymbol: stock.tradingViewSymbol,
    dataDate: data.dataDate,
    sAlpha: isTriggered(data.sAlphaRaw),
    l1: isTriggered(data.l1Raw),
    sAlphaRaw: data.sAlphaRaw,
    l1Raw: data.l1Raw,
    checkedAt: new Date().toISOString(),
    error: "",
    elapsedMs: Date.now() - startedAt,
    modeUsed,
    fallbackReason,
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  row.push(field.replace(/\r$/, ""));
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

function normalizeStock(candidate) {
  let tradingViewSymbol = String(candidate.tradingViewSymbol ?? candidate.symbol ?? "").trim().toUpperCase();
  let code = String(candidate.code ?? "").trim();
  let market = normalizeMarket(candidate.market);
  const symbolMatch = tradingViewSymbol.match(/^(TWSE|TPEX):(\d{4})$/);
  if (symbolMatch) {
    market = symbolMatch[1];
    code = symbolMatch[2];
  }
  if (!/^\d{4}$/.test(code) || !["TWSE", "TPEX"].includes(market)) return null;
  tradingViewSymbol = `${market}:${code}`;
  return {
    code,
    name: String(candidate.name ?? "").trim(),
    market,
    tradingViewSymbol,
  };
}

function dedupeStocks(stocks) {
  const unique = new Map();
  for (const candidate of stocks) {
    const stock = normalizeStock(candidate);
    if (stock) unique.set(stock.tradingViewSymbol, stock);
  }
  const output = [...unique.values()];
  return maxSymbols > 0 ? output.slice(0, maxSymbols) : output;
}

async function loadStocksFromFile(path) {
  const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  if (/\.csv$/i.test(path)) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new ScannerError(`CSV 沒有股票資料：${path}`);
    const headers = rows[0].map((value) => value.trim().toLowerCase());
    const values = rows.slice(1).map((cells) => {
      const get = (...names) => {
        const index = headers.findIndex((header) => names.includes(header));
        return index >= 0 ? cells[index] : "";
      };
      return {
        code: get("code", "代碼", "股票代碼"),
        name: get("name", "名稱", "股票名稱"),
        market: get("market", "市場", "交易所"),
        tradingViewSymbol: get("tradingviewsymbol", "symbol", "商品"),
      };
    });
    const stocks = dedupeStocks(values);
    if (!stocks.length) throw new ScannerError(`CSV 找不到 TWSE/TPEX 四位數股票：${path}`);
    return stocks;
  }

  const symbols = text.match(/(?:TWSE|TPEX):\d{4}/gi) ?? [];
  const stocks = dedupeStocks(symbols.map((symbol) => ({ tradingViewSymbol: symbol })));
  if (!stocks.length) throw new ScannerError(`文字檔找不到 TWSE:2330 這種格式：${path}`);
  return stocks;
}

async function openWatchlistPanel(session) {
  const result = await session.evaluate(pageFunction(() => {
    const visible = (element) => Boolean(element && element.getClientRects().length);
    const label = (element) => [element.textContent, element.getAttribute?.("aria-label")]
      .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const button = [...document.querySelectorAll("button, [role='button']")]
      .filter(visible)
      .find((element) => /觀察清單、詳情和新聞|Watchlist, details and news/i.test(label(element)));
    if (!button) return false;
    const openWidget = document.querySelector(".widgetbar-widget-watchlist, [class*='widgetbar-widget-watchlist']");
    if (visible(openWidget) && (openWidget.innerText?.trim() || openWidget.querySelector("[data-symbol], [data-ticker], [data-symbol-short]"))) {
      return true;
    }
    if (button.getAttribute("aria-pressed") === "true") return true;
    button.click();
    return true;
  }));
  if (!result) throw new ScannerError("找不到 TradingView 觀察清單按鈕");
  await sleep(500);
}

async function collectCurrentWatchlist(session) {
  await openWatchlistPanel(session);
  const empty = await session.evaluate(pageFunction(() =>
    /觀察清單沒有任何品種|watchlist (?:doesn't|does not) have any symbols/i.test(document.body?.innerText ?? ""),
  ));
  if (empty) {
    throw new ScannerError("目前選中的 TradingView 觀察清單是空的；請先換到有股票的清單，或改用 --input CSV/TXT");
  }

  const collected = new Map();
  let previousScroll = -1;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const page = await session.evaluate(pageFunction(() => {
      const visible = (element) => Boolean(element && element.getClientRects().length);
      const widget = document.querySelector(".widgetbar-widget-watchlist, [class*='widgetbar-widget-watchlist']");
      const listRoot = widget && [...widget.querySelectorAll("div")]
        .find((element) => /(?:^|\s)watchlist-[\w-]+(?:\s|$)/.test(String(element.className)));
      if (!listRoot) return { candidates: [], scrollTop: 0, maxScroll: 0, done: true };
      const candidates = [];
      for (const anchor of [...listRoot.querySelectorAll("a[href*='/symbols/']")].filter(visible)) {
        const match = anchor.href.match(/\/symbols\/(TWSE|TPEX)-(\d{4})\/?/i);
        if (match) candidates.push({
          market: match[1].toUpperCase(),
          code: match[2],
          name: anchor.textContent?.trim() ?? "",
        });
      }
      for (const element of [...listRoot.querySelectorAll("[data-symbol], [data-ticker], [data-symbol-short]")].filter(visible)) {
        const raw = ["data-symbol", "data-ticker", "data-symbol-short"]
          .map((name) => element.getAttribute(name)).find(Boolean) ?? "";
        const match = raw.match(/\b(TWSE|TPEX):(\d{4})\b/i);
        if (match) candidates.push({ market: match[1].toUpperCase(), code: match[2], name: "" });
      }

      const tickerElements = [...listRoot.querySelectorAll("a[href*='/symbols/TWSE-'], a[href*='/symbols/TPEX-'], [data-symbol], [data-ticker]")]
        .filter(visible);
      let scroller = null;
      for (const element of tickerElements) {
        let parent = element.parentElement;
        while (parent && parent !== document.body) {
          if (parent.scrollHeight > parent.clientHeight + 20) {
            scroller = parent;
            break;
          }
          parent = parent.parentElement;
        }
        if (scroller) break;
      }
      if (!scroller) {
        const options = [...listRoot.querySelectorAll("div")].filter((element) =>
          visible(element) && element.scrollHeight > element.clientHeight + 100 && element.clientHeight > 120,
        );
        scroller = options.sort((a, b) => a.clientWidth - b.clientWidth)[0] ?? null;
      }
      if (!scroller) return { candidates, scrollTop: 0, maxScroll: 0, done: true };
      const before = scroller.scrollTop;
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = Math.min(maxScroll, before + Math.max(180, scroller.clientHeight * 0.8));
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      return { candidates, scrollTop: scroller.scrollTop, maxScroll, done: scroller.scrollTop >= maxScroll - 2 };
    }));

    for (const value of page.candidates ?? []) {
      const stock = normalizeStock(value);
      if (stock) collected.set(stock.tradingViewSymbol, stock);
    }
    if (page.done || page.scrollTop === previousScroll) break;
    previousScroll = page.scrollTop;
    await sleep(180);
  }
  const stocks = dedupeStocks([...collected.values()]);
  if (!stocks.length) {
    throw new ScannerError("無法從目前觀察清單讀到台股。可先用 TradingView 上傳的 TXT 當 --input 掃描");
  }
  return stocks;
}

function csvEscape(value) {
  const text = value === true ? "TRUE" : value === false ? "FALSE" : String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows) {
  const headers = [
    "Status", "Signal", "Code", "Name", "Market", "TradingViewSymbol", "DataDate",
    "SAlpha", "L1", "SAlphaRaw", "L1Raw", "CheckedAt", "Error",
    "ElapsedMs", "ModeUsed", "FallbackReason",
  ];
  const keys = [
    "status", "signal", "code", "name", "market", "tradingViewSymbol", "dataDate",
    "sAlpha", "l1", "sAlphaRaw", "l1Raw", "checkedAt", "error",
    "elapsedMs", "modeUsed", "fallbackReason",
  ];
  return `\uFEFF${headers.map(csvEscape).join(",")}\r\n${rows
    .map((row) => keys.map((key) => csvEscape(row[key])).join(","))
    .join("\r\n")}\r\n`;
}

function timestamp() {
  const date = new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((output, item) => ({ ...output, [item.type]: item.value }), {});
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

async function writeReports(rows, runTimestamp) {
  await mkdir(reportDirectory, { recursive: true });
  const signals = rows.filter((row) => row.status === "OK" && (row.sAlpha || row.l1));
  const errors = rows.filter((row) => row.status !== "OK");
  const files = {
    audit: resolve(reportDirectory, `TradingView-scan-${runTimestamp}.csv`),
    signals: resolve(reportDirectory, `TradingView-signals-${runTimestamp}.csv`),
    errors: resolve(reportDirectory, `TradingView-errors-${runTimestamp}.csv`),
    auditLatest: resolve(reportDirectory, "TradingView-scan-latest.csv"),
    signalsLatest: resolve(reportDirectory, "TradingView-signals-latest.csv"),
    errorsLatest: resolve(reportDirectory, "TradingView-errors-latest.csv"),
  };
  await Promise.all([
    writeFile(files.audit, rowsToCsv(rows), "utf8"),
    writeFile(files.signals, rowsToCsv(signals), "utf8"),
    writeFile(files.errors, rowsToCsv(errors), "utf8"),
    writeFile(files.auditLatest, rowsToCsv(rows), "utf8"),
    writeFile(files.signalsLatest, rowsToCsv(signals), "utf8"),
    writeFile(files.errorsLatest, rowsToCsv(errors), "utf8"),
  ]);
  return { files, signals, errors };
}

function stockFingerprint(stocks) {
  return createHash("sha256")
    .update(stocks.map((stock) => stock.tradingViewSymbol).join("\n"))
    .digest("hex");
}

async function loadCheckpoint(path, fingerprint) {
  if (!resume) return [];
  try {
    const checkpoint = JSON.parse(await readFile(path, "utf8"));
    if (checkpoint.fingerprint !== fingerprint || !Array.isArray(checkpoint.rows)) return [];
    return checkpoint.rows;
  } catch {
    return [];
  }
}

async function saveCheckpoint(path, fingerprint, rows) {
  await writeFile(path, JSON.stringify({ fingerprint, rows }, null, 2), "utf8");
}

async function login() {
  const session = await openSession("https://tw.tradingview.com/accounts/signin/", { reuseChart: false });
  try {
    await navigate(session, "https://tw.tradingview.com/accounts/signin/");
    console.log("已開啟掃描器專用的 Chrome。請登入 TradingView。\n");
    console.log("登入後開啟你的 EVA初號機 圖表，確認圖上有 tTMA ST 1.0.000 指標。");
    const input = createInterface({ input: process.stdin, output: process.stdout });
    await input.question("完成後回到這裡按 Enter：");
    input.close();
    await navigate(session, chartUrl);
    console.log(`登入資料只保存在本機：${profileDirectory}`);
  } finally {
    session.close();
  }
}

async function check() {
  const session = await openSession(chartUrl);
  try {
    await ensureChartPage(session);
    if (await loginRequired(session)) throw new ScannerError("TradingView 尚未登入，請先執行 login");
    await ensureDataWindow(session);
    await moveMouseOutsideChart(session);
    const data = await waitUntil(() => readSignalData(session), 10_000, "讀不到 tTMA 最新數值");
    console.log(JSON.stringify({
      ...data,
      sAlpha: isTriggered(data.sAlphaRaw),
      l1: isTriggered(data.l1Raw),
    }, null, 2));
  } finally {
    session.close();
  }
}

async function scan() {
  const scanStartedAt = Date.now();
  const session = await openSession(chartUrl);
  const runTimestamp = timestamp();
  const checkpointPath = resolve(reportDirectory, "TradingView-scan-checkpoint.json");
  try {
    await ensureChartPage(session);
    if (await loginRequired(session)) throw new ScannerError("TradingView 尚未登入，請先執行 login");
    const sourceStocks = fromWatchlist
      ? await collectCurrentWatchlist(session)
      : await loadStocksFromFile(inputPath);
    const stocks = eligibleStocks(sourceStocks);
    const excluded = sourceStocks.filter((stock) => excludedSymbols.has(stock.tradingViewSymbol));
    if (excluded.length) console.log(`固定排除 ${excluded.length} 檔（不掃描、不重試）：${excluded.map((stock) => stock.tradingViewSymbol).join("、")}`);
    console.log(`股票來源：${fromWatchlist ? "目前 TradingView 觀察清單" : inputPath}`);
    console.log(`準備掃描 ${stocks.length} 檔；只讀取最新一根日 K 的 S Alpha 與 L1。`);
    console.log(`模式：${speed === "fast" ? "快速（資料就緒即讀取，必要時保守補讀）" : "保守"}`);

    const fingerprint = stockFingerprint(sourceStocks);
    const rows = eligibleStocks(await loadCheckpoint(checkpointPath, fingerprint));
    const completed = new Set(rows.filter((row) => row.status === "OK").map((row) => row.tradingViewSymbol));
    if (rows.length) console.log(`續跑：已載入 ${rows.length} 筆檢查點。`);

    let attempts = 0;
    for (let pass = 1; pass <= maxPasses; pass += 1) {
      const remaining = stocks.filter((stock) => !completed.has(stock.tradingViewSymbol));
      if (!remaining.length) break;
      if (pass > 1) {
        console.log(`\n第 ${pass}/${maxPasses} 輪：重新掃描 ${remaining.length} 檔載入失敗股票。`);
        await sleep(10_000);
      }
      for (const stock of remaining) {
        const index = stocks.findIndex((value) => value.tradingViewSymbol === stock.tradingViewSymbol);
        process.stdout.write(`[${index + 1}/${stocks.length}] ${stock.tradingViewSymbol}${stock.name ? ` ${stock.name}` : ""} ... `);
        let row;
        try {
          row = await scanOne(session, stock);
          completed.add(stock.tradingViewSymbol);
          console.log(`${row.signal || "無訊號"}${pass > 1 ? `（第${pass}輪成功）` : ""} (${(row.elapsedMs / 1_000).toFixed(1)}s, ${row.modeUsed})`);
        } catch (error) {
          row = {
            status: "ERROR",
            signal: "",
            code: stock.code,
            name: stock.name ?? "",
            market: stock.market,
            tradingViewSymbol: stock.tradingViewSymbol,
            dataDate: "",
            sAlpha: false,
            l1: false,
            sAlphaRaw: "",
            l1Raw: "",
            checkedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
            elapsedMs: error.elapsedMs ?? 0,
            modeUsed: error.modeUsed ?? speed,
            fallbackReason: error.fallbackReason ?? "",
          };
          console.log(`錯誤：${row.error}`);
        }
        const oldIndex = rows.findIndex((value) => value.tradingViewSymbol === stock.tradingViewSymbol);
        if (oldIndex >= 0) rows[oldIndex] = row;
        else rows.push(row);
        attempts += 1;
        await mkdir(reportDirectory, { recursive: true });
        await saveCheckpoint(checkpointPath, fingerprint, rows);
        if (attempts % 20 === 0) await writeReports(rows, runTimestamp);
      }
    }

    rows.sort((a, b) => stocks.findIndex((stock) => stock.tradingViewSymbol === a.tradingViewSymbol) -
      stocks.findIndex((stock) => stock.tradingViewSymbol === b.tradingViewSymbol));
    const report = await writeReports(rows, runTimestamp);
    const summary = {
      startedAt: new Date(scanStartedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      wallTimeMs: Date.now() - scanStartedAt,
      speed,
      input: fromWatchlist ? "TradingView watchlist" : inputPath,
      stocks: stocks.length,
      attempts,
      ok: rows.filter((row) => row.status === "OK").length,
      errors: report.errors.length,
      signals: report.signals.length,
      safeFallbackRows: rows.filter((row) => row.modeUsed === "safe-fallback").length,
    };
    await Promise.all([
      writeFile(resolve(reportDirectory, `TradingView-scan-summary-${runTimestamp}.json`), JSON.stringify(summary, null, 2), "utf8"),
      writeFile(resolve(reportDirectory, "TradingView-scan-summary-latest.json"), JSON.stringify(summary, null, 2), "utf8"),
    ]);
    console.log("\n掃描完成：");
    console.log(`  觸發股票 ${report.signals.length} 檔：${report.files.signalsLatest}`);
    console.log(`  完整稽核 ${rows.length} 檔：${report.files.auditLatest}`);
    console.log(`  失敗 ${report.errors.length} 檔：${report.files.errorsLatest}`);
    console.log(`  總耗時 ${(summary.wallTimeMs / 60_000).toFixed(1)} 分鐘；保守補讀 ${summary.safeFallbackRows} 檔`);
  } finally {
    session.close();
  }
}

async function selfTest() {
  // This existing Actions preflight now covers the startup race regression.
  const browserTestsExit = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--test", resolve(here, "tradingview-browser-readiness.test.mjs")], {
      stdio: "inherit", windowsHide: true,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
  if (browserTestsExit !== 0) throw new ScannerError("瀏覽器載入等待測試失敗");
  const stocks = await loadStocksFromFile(inputPath);
  console.log(`排除後待掃描 ${eligibleStocks(stocks).length} 檔；固定排除：${[...excludedSymbols].join("、")}`);
  const double = stocks.find((stock) => stock.code === "3324");
  const assertions = [
    [stocks.length === (maxSymbols > 0 ? Math.min(maxSymbols, 1_000) : 1_000), `股票數量為 ${stocks.length}`],
    [maxSymbols > 0 || (double?.market === "TPEX" && double.tradingViewSymbol === "TPEX:3324"), "3324 正確識別為 TPEX:3324"],
    [isTriggered("−100.00%") === false, "−100.00% 判定為未觸發"],
    [isTriggered("−99.90%") === true, "−99.90% 判定為觸發"],
    [isTriggered("−99.99%") === true, "高價股四捨五入的 −99.99% 判定為觸發"],
    [isTriggered("0") === false && isTriggered("1") === true, "一般價格刻度 0/1 判讀正確"],
  ];
  const failed = assertions.filter(([ok]) => !ok);
  for (const [ok, description] of assertions) console.log(`${ok ? "PASS" : "FAIL"}  ${description}`);
  if (failed.length) throw new ScannerError(`自我測試失敗 ${failed.length} 項`);
}

async function diagnoseWatchlist() {
  const session = await openSession(chartUrl);
  try {
    await ensureChartPage(session);
    if (await loginRequired(session)) throw new ScannerError("TradingView 尚未登入，請先執行 login");
    let openError = "";
    try { await openWatchlistPanel(session); } catch (error) { openError = error instanceof Error ? error.message : String(error); }
    const details = await session.evaluate(pageFunction((capturedOpenError) => {
      const widget = document.querySelector(".widgetbar-widget-watchlist, [class*='widgetbar-widget-watchlist']");
      if (!widget) return {
        error: "missing-widget",
        openError: capturedOpenError,
        title: document.title,
        url: location.href,
        pageText: (document.body?.innerText ?? "").slice(0, 3_000),
        buttons: [...document.querySelectorAll("button, [role='button']")].map((element) => ({
          text: element.textContent?.trim().replace(/\s+/g, " ").slice(0, 160) ?? "",
          ariaLabel: element.getAttribute("aria-label"),
          title: element.getAttribute("title"),
          className: String(element.className).slice(0, 180),
        })).filter((item) => item.text || item.ariaLabel || item.title).slice(0, 180),
      };
      const interesting = [...widget.querySelectorAll("*")]
        .filter((element) => {
          const text = element.textContent?.trim() ?? "";
          const attrs = [...element.attributes].map((attribute) => `${attribute.name}=${attribute.value}`).join(" ");
          return /^\d{4}$/.test(text) || /symbol|ticker|TWSE|TPEX|2327|2408/i.test(attrs);
        })
        .slice(0, 160)
        .map((element) => ({
          tag: element.tagName,
          className: String(element.className).slice(0, 240),
          text: (element.textContent?.trim() ?? "").replace(/\s+/g, " ").slice(0, 240),
          attributes: Object.fromEntries([...element.attributes]
            .map((attribute) => [attribute.name, attribute.value.slice(0, 500)])),
        }));
      return {
        openError: capturedOpenError,
        title: document.title,
        widgetClass: String(widget.className),
        widgetRect: (() => {
          const rect = widget.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, rects: widget.getClientRects().length };
        })(),
        widgetParentClass: String(widget.parentElement?.className ?? ""),
        widgetText: (widget.innerText ?? "").slice(0, 3_000),
        widgetHtml: widget.innerHTML.slice(0, 12_000),
        childSummary: [...widget.querySelectorAll("*")].slice(0, 120).map((element) => ({
          tag: element.tagName,
          className: String(element.className).slice(0, 180),
          text: (element.textContent?.trim() ?? "").replace(/\s+/g, " ").slice(0, 120),
          shadow: Boolean(element.shadowRoot),
        })),
        sideButtons: [...document.querySelectorAll("button, [role='button']")]
          .filter((element) => /觀察清單、詳情和新聞|Watchlist, details and news/i.test([
            element.textContent,
            element.getAttribute?.("aria-label"),
            element.getAttribute?.("title"),
          ].filter(Boolean).join(" ")))
          .map((element) => ({
            className: String(element.className),
            ariaLabel: element.getAttribute("aria-label"),
            ariaPressed: element.getAttribute("aria-pressed"),
            dataActive: element.getAttribute("data-active"),
            rect: (() => {
              const rect = element.getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            })(),
          })),
        interesting,
      };
    }, openError));
    await mkdir(reportDirectory, { recursive: true });
    const screenshot = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const screenshotPath = resolve(reportDirectory, "TradingView-dedicated-Chrome-diagnostic.png");
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    details.screenshot = screenshotPath;
    console.log(JSON.stringify(details, null, 2));
  } finally {
    session.close();
  }
}

function help() {
  console.log(`TradingView tTMA 真實訊號掃描器

用法：
  node tradingview-signal-scanner.mjs login
      第一次登入掃描器專用 Chrome。

  node tradingview-signal-scanner.mjs check
      驗證目前圖表可讀到 tTMA 的 S Alpha / L1。

  node tradingview-signal-scanner.mjs diagnose-readiness
      唯讀診斷目前圖表／數據視窗，不切股、不開啟面板。

  node tradingview-signal-scanner.mjs self-test
      不開瀏覽器，檢查股票清單解析與 0/1 訊號判讀。

  node tradingview-signal-scanner.mjs scan
      掃描 reports/top1000-turnover-latest.csv（成交值前 1000 名）。

  node tradingview-signal-scanner.mjs scan --watchlist
      掃描 TradingView 目前選中的非空觀察清單。

常用選項：
  --input <CSV或TXT>     自訂股票清單；TXT 使用 TWSE:2330,TPEX:3324 格式
  --max-symbols <數量>  只掃描前 N 檔，適合先測試
  --resume              從相同股票清單的檢查點續跑
  --delay-ms <毫秒>     每次切股後額外等待，預設 750
  --timeout-ms <毫秒>   單檔切換／載入逾時，預設 15000
  --passes <輪數>       載入失敗股票的掃描輪數，預設 3
  --chart-url <網址>    指定已載入 tTMA ST 的 TradingView 圖表網址
  --switch-mode <模式>  url（預設，整頁切股）、keyboard（主圖鍵盤切股）或 ui
  --speed <模式>        safe（預設）或 fast（就緒即讀取，失敗自動保守補讀）

判讀原則：
  只讀最新一根日 K 的數據視窗，不回溯舊訊號。百分比刻度下 0 顯示為
  -100.00%，1 顯示為 -99.90%；程式直接讀 plot 值，不做圖片辨識。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (command === "login") await login();
    else if (command === "check") await check();
    else if (command === "self-test") await selfTest();
    else if (command === "diagnose-watchlist") await diagnoseWatchlist();
    else if (command === "diagnose-readiness") await diagnoseReadiness();
    else if (command === "scan") await scan();
    else help();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
