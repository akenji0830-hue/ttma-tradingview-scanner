import { readFile, writeFile, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBrowserWithSession } from './tradingview-session.mjs';
import { marketDayStatus, taipeiDate } from './market-day.mjs';
import { withRecovery, runScanner, createMailer, saveDelivery, recipient } from './reliability.mjs';

// This second gate also protects manual/API dispatches and old queued crons.
// It runs before loading credentials, starting Chrome, or preparing any email.
const marketDay = await withRecovery(() => marketDayStatus());
console.log(`Market day ${marketDay.date}: ${marketDay.reason}`);
if (!marketDay.allowed || process.argv.includes('--check-market-day')) {
  console.log('No scan or email started.');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const scanner = resolve(here, '..');
const date = marketDay.date;
const test = process.argv.includes('--test');
const runDir = resolve(here, 'runs', `${date}-${Date.now()}${test ? '-test' : ''}`);
const lockPath = resolve(here, 'scan.lock');
const smtpUser = process.env.SMTP_USER || 'akenji0830@gmail.com';
// Explicit cloud configuration keeps the existing Windows launcher unchanged.
for (const key of ['TV_SIGNAL_CHROME_PATH', 'TV_SIGNAL_PROFILE_DIR']) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}
if (!process.env.TV_SESSION_COOKIES_B64) {
  throw new Error('Missing TV_SESSION_COOKIES_B64. The hosted runner cannot use your Windows Chrome login.');
}
if (!test && !process.env.SMTP_PASS) {
  throw new Error('Configure the Gmail app password as SMTP_PASS before a full cloud run.');
}
await mkdir(runDir, { recursive: true });
const lock = await open(lockPath, 'wx').catch(() => { throw new Error('Another run is active, or a previous run left scan.lock. Check the process before removing the lock.'); });
let transport;
let stopBrowser;
try {
  await lock.writeFile(String(process.pid));
  if (!test) {
    transport = await createMailer();
    await withRecovery(() => transport.verify(), { attempts: 2 });
  }
  const deadline = Date.now() + 210 * 60 * 1000;
  let summary;
  await withRecovery(async (attempt) => {
    const remaining = deadline - Date.now();
    if (remaining < 30000 || taipeiDate() !== date) {
      const error = new Error('Recovery time/date budget exhausted'); error.code = 'BUDGET'; throw error;
    }
    console.log(`Scan recovery attempt ${attempt}/3 (successful checkpoint rows will be retained).`);
    try {
      stopBrowser = await startBrowserWithSession({
        chromePath: process.env.TV_SIGNAL_CHROME_PATH,
        profileDirectory: process.env.TV_SIGNAL_PROFILE_DIR,
        port: Number(process.env.TV_SIGNAL_CHROME_PORT || 9224),
        encodedCookies: process.env.TV_SESSION_COOKIES_B64,
      });
  const args = [resolve(scanner, 'tradingview-signal-scanner.mjs'), 'scan',
    '--input', resolve(here, 'stocks.txt'), '--output-dir', runDir,
    '--speed', 'safe', '--switch-mode', 'url', '--passes', '2', '--resume'];
  if (test) args.push('--max-symbols', '5', '--passes=1');
  await runScanner(args, { timeoutMs: Math.min(125 * 60 * 1000, remaining) });
  summary = JSON.parse(await readFile(resolve(runDir, 'TradingView-scan-summary-latest.json'), 'utf8'));
  if (!test && summary.stocks !== 997) throw new Error(`Expected 997 eligible stocks, received ${summary.stocks}. No result email sent.`);
  if (summary.ok === 0 || summary.ok + summary.errors !== summary.stocks) {
    throw new Error('Scan output is incomplete or contains no successfully checked stocks.');
  }
  // The scanner has already made two passes over every unresolved stock.
  // Keep its explicit ERROR rows and finish the report instead of restarting
  // a 1000-stock run for a handful of unavailable charts.
    } finally {
      await stopBrowser?.();
      stopBrowser = null;
    }
  }, { attempts: 3, delayMs: 10000, onRetry: async (error, attempt) => {
    console.warn(`Attempt ${attempt} interrupted; restarting from checkpoint: ${error.message}`);
  } });
  const allSignals = parseCsv(await readFile(resolve(runDir, 'TradingView-signals-latest.csv'), 'utf8'));
  const audit = parseCsv(await readFile(resolve(runDir, 'TradingView-scan-latest.csv'), 'utf8'));
  const auditHeader = audit[0] ?? [];
  const statusColumn = auditHeader.indexOf('Status');
  const dateColumn = auditHeader.indexOf('DataDate');
  const auditedRows = audit.slice(1);
  const freshRows = auditedRows.filter((row) => row[statusColumn] === 'OK' && row[dateColumn] === date);
  if (freshRows.length !== summary.ok) {
    throw new Error(`Fresh-data check failed: ${freshRows.length}/${summary.ok} successful rows match scan date ${date}. No result email sent.`);
  }
  const todaySignals = allSignals.slice(1).filter((row) => row[6] === date);
  const todayPath = resolve(runDir, 'TradingView-signals-today.csv');
  await writeFile(todayPath, toCsv([allSignals[0], ...todaySignals]), 'utf8');
  if (test) {
    console.log(`Cloud test finished: ${summary.ok}/${summary.stocks} checked, ${todaySignals.length} current-date signals. No email sent. Check DataDate in: ${runDir}`);
  } else {
    const message = {
      from: smtpUser,
      to: recipient,
      messageId: `<ttma-signals-${date}-${process.env.GITHUB_RUN_ID || Date.now()}@ttma-scanner.invalid>`,
      subject: `[TradingView] ${date} L1 / S Alpha：今日 ${todaySignals.length} 檔，${summary.errors} 檔讀取失敗已跳過${summary.errors ? '（結果未齊）' : ''}`,
      text: `本次掃描：${summary.stocks} 檔；成功 ${summary.ok} 檔；讀取失敗並跳過 ${summary.errors} 檔。每檔讀取失敗的股票已在兩輪中各嘗試一次，仍無法讀取者保留為錯誤並列入失敗清單，不會當成無訊號。\n訊號附件只保留 DataDate = ${date} 的股票；完整稽核與失敗清單亦附上。${summary.errors ? '\n注意：結果未齊，未讀取的股票不能視為沒有訊號。' : ''}`,
      attachments: [
        { filename: 'TradingView-signals-today.csv', path: todayPath },
        ...['TradingView-scan-latest.csv', 'TradingView-errors-latest.csv'].map((filename) => ({ filename, path: resolve(runDir, filename) })),
      ],
    };
    const info = await withRecovery(() => transport.sendMail(message), { attempts: 2 });
    await saveDelivery(date, summary, info);
  }
} catch (error) {
  await writeFile(resolve(runDir, 'failure.json'), JSON.stringify({ date, error: error.message, at: new Date().toISOString() }), 'utf8');
  throw error;
} finally {
  transport?.close();
  await stopBrowser?.();
  await lock.close();
  await unlink(lockPath);
}

function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value !== '')) rows.push(row);
      row = []; field = '';
    } else field += char;
  }
  row.push(field.replace(/\r$/, ''));
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

function toCsv(rows) {
  return `\uFEFF${rows.map((row) => row.map((field) => `"${String(field ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n')}\r\n`;
}
