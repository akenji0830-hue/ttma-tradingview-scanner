// Pure parsing/readiness helpers: importing this module never opens a browser.
export function parsePlotNumber(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /^(?:—|-|∅|N\/A|NA)$/i.test(text)) return null;
  const value = Number(text.replace(/[−–—]/g, "-").replace(/[%％,\s\u00a0\u202f]/g, ""));
  return Number.isFinite(value) ? value : null;
}

export function isTriggered(raw) {
  const text = String(raw ?? "").trim();
  const value = parsePlotNumber(text);
  if (value === null) return false;
  return /[%％]/.test(text) ? value > -99.995 : Math.abs(value) > 0.5;
}

export function isDailyInterval(text) {
  return /(?:^|[\s,，、·:：])(1\s*D|D|1\s*天|1\s*日|日線|日線圖|daily|1\s*day)(?=$|[\s,，、·]|的圖表)/i.test(String(text ?? ""));
}

function intervalKind(text) {
  const value = String(text ?? "");
  // Unknown labels can use the other source's explicit daily interval; an
  // explicitly different interval must never be overridden by that source.
  const nonDailyUnit = /(?:^|[\s,，、·:：])(?:\d+\s*)?(?:秒|分(?:鐘)?|小時|時|週|周|月|季|年|seconds?|secs?|minutes?|mins?|hours?|hrs?|weeks?|months?|quarters?|years?|S|H|W|M|weekly|monthly|hourly|intraday)(?=$|[\s,，、·]|的圖表)/i;
  const days = [...value.matchAll(/(?:^|[\s,，、·:：])(\d+)\s*(?:D|天|日|days?)(?=$|[\s,，、·]|的圖表)/gi)];
  const bareMinutes = /^\s*\d+\s*$/.test(value) || /(?:[，、,])\s*\d+\s*(?:的圖表|chart(?:\s|$))/i.test(value);
  if (nonDailyUnit.test(value) || days.some((match) => Number(match[1]) !== 1) || bareMinutes) return "non-daily";
  return isDailyInterval(value) ? "daily" : "unknown";
}

export function parseReadinessSnapshot(raw) {
  const text = String(raw?.bodyText ?? "");
  const start = Math.max(text.lastIndexOf("日期\n"), text.lastIndexOf("Date\n"));
  const block = start < 0 ? "" : text.slice(start, start + 2_800);
  const signal = block.match(/(?:日期|Date)\n([^\n]+)[\s\S]*?🔥 S Alpha\n([^\n]+)\n🟢 L1\n([^\n]+)/);
  const identity = block.match(/\n(\d{4})\s*·([^\n]*)·\s*(TWSE|TPEX)\s*(?:\n|$)/i);
  const chartLabels = (raw?.chartLabels ?? []).filter((label) => /圖表|chart/i.test(label));
  const charts = chartLabels.map((label) => {
    const match = label.match(/\b(TWSE|TPEX):(\d{4})\b/i);
    return match ? { market: match[1].toUpperCase(), code: match[2], interval: intervalKind(label) } : null;
  }).filter(Boolean);
  const uniqueCharts = [...new Map(charts.map((chart) => [`${chart.market}:${chart.code}`, chart])).values()];
  const chart = uniqueCharts.length === 1 ? uniqueCharts[0] : null;
  // Recent TradingView layouts can omit the chart's accessibility label even
  // while the chart is fully loaded. The URL is then an independent main-chart
  // identity source; it is only used together with the data-window identity.
  const urlSymbol = String(raw?.url ?? "").match(/[?&]symbol=(?:TWSE|TPEX)%3A(\d{4})|[?&]symbol=(?:TWSE|TPEX):(\d{4})/i);
  const urlMarket = String(raw?.url ?? "").match(/[?&]symbol=(TWSE|TPEX)(?:%3A|:)/i)?.[1]?.toUpperCase() ?? null;
  const urlCode = urlSymbol?.[1] ?? urlSymbol?.[2] ?? null;
  const titleCode = String(raw?.title ?? "").match(/^\s*(\d{4})\b/)?.[1] ?? null;
  const dataInterval = intervalKind(identity?.[2]);
  return {
    // After a visible symbol switch, TradingView can retain the old symbol in
    // the URL while the title and data window already reflect the new chart.
    // Prefer the live title; the data-window check below independently guards
    // against a title that changes before indicator data has caught up.
    chartCode: chart?.code ?? titleCode ?? urlCode,
    chartMarket: chart?.market ?? (titleCode ? null : urlMarket),
    chartDaily: (Boolean(chart) && charts.some((item) => item.interval === "daily")) || (!chart && dataInterval === "daily" && Boolean(titleCode ?? urlCode)),
    chartNonDaily: charts.some((item) => item.interval === "non-daily"),
    dataDaily: dataInterval === "daily",
    dataNonDaily: dataInterval === "non-daily",
    code: identity?.[1] ?? null,
    market: identity?.[3]?.toUpperCase() ?? null,
    dataDate: signal?.[1]?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null,
    sAlphaRaw: signal?.[2]?.trim() ?? null,
    l1Raw: signal?.[3]?.trim() ?? null,
    busy: Boolean(raw?.busy),
    documentReady: ["interactive", "complete"].includes(raw?.readyState),
  };
}

export function readinessIssue(snapshot, stock, { documentMatches = true, pointerMoved = true } = {}) {
  if (!documentMatches) return "尚未進入本次換股的新頁面";
  if (!pointerMoved) return "游標尚未移離 K 線";
  if (!snapshot?.documentReady) return "頁面尚未就緒";
  if (snapshot.chartCode !== stock.code || (snapshot.chartMarket && snapshot.chartMarket !== stock.market)) return "主圖股票尚未同步";
  if (snapshot.code !== stock.code || snapshot.market !== stock.market) return "數據視窗股票尚未同步";
  if (snapshot.chartNonDaily || snapshot.dataNonDaily) return "圖表或數據視窗顯示非日 K 週期";
  if (!snapshot.chartDaily && !snapshot.dataDaily) return "無法確認圖表為日 K";
  if (!snapshot.dataDate) return "尚未讀到資料日期";
  if (snapshot.busy) return "圖表仍在載入";
  if (parsePlotNumber(snapshot.sAlphaRaw) === null || parsePlotNumber(snapshot.l1Raw) === null) return "S Alpha 或 L1 尚未載入有效數值";
  return "";
}

export function createReadinessGate(stock, { stableMs = 300 } = {}) {
  let previousKey = null;
  let stableSince = 0;
  return (snapshot, now, context = {}) => {
    const issue = readinessIssue(snapshot, stock, context);
    if (issue) {
      previousKey = null;
      return { ready: false, issue };
    }
    const key = JSON.stringify([
      snapshot.chartCode, snapshot.chartMarket, snapshot.chartDaily, snapshot.dataDaily,
      snapshot.chartNonDaily, snapshot.dataNonDaily,
      snapshot.code, snapshot.market, snapshot.dataDate, snapshot.sAlphaRaw, snapshot.l1Raw,
    ]);
    if (key !== previousKey) {
      previousKey = key;
      stableSince = now;
      return { ready: false, issue: "等待連續一致的指標數值" };
    }
    return now - stableSince >= stableMs
      ? { ready: true, data: snapshot, issue: "" }
      : { ready: false, issue: "等待連續一致的指標數值" };
  };
}

export function chooseDataWindowAction(controls, state, now) {
  if (controls.hasSignalBlock) return "";
  // Selecting a tab is idempotent. Retry it when an early click happened before
  // the application's event handlers were attached.
  if (controls.dataTabFound) return now - (state.lastTabClickAt ?? -Infinity) >= 600 ? "tab" : "";
  if (!controls.sideButtonFound || (state.panelClicks ?? 0) >= 3) return "";
  const active = [controls.sideAriaPressed, controls.sideDataActive, controls.sideAriaExpanded];
  if (active.includes("true")) return "";
  // The sidebar button toggles. Never infer 'closed' merely from a tab that has
  // not painted yet, and never toggle a button with unknown active state.
  if (!active.includes("false")) return "";
  return now - (state.lastPanelClickAt ?? -Infinity) >= 1_000 ? "panel" : "";
}

export async function runWithSafeFallback(fast, safe) {
  try {
    return { data: await fast(), modeUsed: "fast", fallbackReason: "" };
  } catch (error) {
    const fallbackReason = error instanceof Error ? error.message : String(error);
    try {
      return { data: await safe(), modeUsed: "safe-fallback", fallbackReason };
    } catch (fallbackError) {
      const failure = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
      failure.modeUsed = "safe-fallback";
      failure.fallbackReason = fallbackReason;
      throw failure;
    }
  }
}
