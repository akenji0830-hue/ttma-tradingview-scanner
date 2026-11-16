// Public TWSE sources only. No trading/account credentials are used here.
export const CALENDAR_URL = 'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule';
export const QUOTE_URL = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw&json=1&delay=0';

export function taipeiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function calendarDate(value) {
  const raw = String(value ?? '');
  if (!/^\d{7,8}$/.test(raw)) throw new Error('Unexpected TWSE calendar date');
  const year = Number(raw.slice(0, -4)) + (raw.length === 7 ? 1911 : 0);
  const iso = `${year}-${raw.slice(-4, -2)}-${raw.slice(-2)}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new Error('Invalid TWSE calendar date');
  }
  return iso;
}

export function calendarStatus(date, rows) {
  if (!Array.isArray(rows)) throw new Error('Invalid TWSE calendar response');
  const records = rows.map((row) => ({ date: calendarDate(row.Date), name: row.Name }));
  const current = records.filter((row) => row.date.startsWith(date.slice(0, 4)));
  // A stale/partial calendar is not evidence that the exchange is open.
  if (current.length < 10 || !current.some((row) => row.date.slice(5, 7) === '01') ||
      !current.some((row) => row.date.slice(5, 7) === '12') ||
      current.some((row) => typeof row.name !== 'string' || !row.name.trim())) {
    throw new Error(`TWSE calendar does not cover ${date.slice(0, 4)}`);
  }
  const closures = current.filter((row) => row.date === date &&
    !/(?:開始交易日|最後交易日)$/.test(row.name));
  return closures.length ? { allowed: false, reason: `TWSE holiday: ${closures[0].name}` } :
    { allowed: true, reason: 'Calendar permits trading' };
}

async function fetchJson(url, fetcher) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetcher(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'ttma-market-day-check' },
        cache: 'no-store', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`TWSE HTTP ${response.status}`);
      return await response.json();
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

export async function marketDayStatus({ now = new Date(), fetcher = fetch } = {}) {
  const date = taipeiDate(now);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return { date, allowed: false, reason: 'Weekend' };
  try {
  const calendar = calendarStatus(date, await fetchJson(CALENDAR_URL, fetcher));
  if (!calendar.allowed) return { date, ...calendar };
  } catch (error) {
    if (!String(error?.message || '').includes('TWSE calendar does not cover')) throw error;
  }
  const quote = await fetchJson(`${QUOTE_URL}&_=${now.getTime()}`, fetcher);
  if (quote?.rtcode !== '0000' || !Array.isArray(quote.msgArray) ||
      !/^\d{8}$/.test(quote.queryTime?.sysDate ?? '')) {
    throw new Error('Invalid TWSE current-session response');
  }
  const compactDate = date.replaceAll('-', '');
  const traded = quote.queryTime.sysDate === compactDate && quote.msgArray.some((row) =>
    row.c === '2330' && row.ex === 'tse' && row.d === compactDate &&
    Number(row.v) > 0 && /^\d{2}:\d{2}:\d{2}$/.test(row.t ?? '') && row.t >= '13:30:00');
  return {
    date, allowed: traded,
    reason: traded ? 'TWSE calendar and current-date closing trade confirmed' :
      'No current-date closing trade confirmed (closed or data not ready)',
  };
}
