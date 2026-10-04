import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBrowserWithSession } from './tradingview-session.mjs';
import { marketDayStatus, taipeiDate } from './market-day.mjs';

// This second gate also protects manual/API dispatches and old queued crons.
// It runs before loading credentials, starting Chrome, or preparing any email.
const marketDay = await marketDayStatus();
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
const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
const smtpPort = Number(process.env.SMTP_PORT || 465);
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
  stopBrowser = await startBrowserWithSession({
    chromePath: process.env.TV_SIGNAL_CHROME_PATH,
    profileDirectory: process.env.TV_SIGNAL_PROFILE_DIR,
    port: Number(process.env.TV_SIGNAL_CHROME_PORT || 9224),
    encodedCookies: process.env.TV_SESSION_COOKIES_B64,
  });
  if (!test) {
    const { default: nodemailer } = await import('nodemailer');
    transport = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      requireTLS: true,
      auth: { user: smtpUser, pass: process.env.SMTP_PASS },
      connectionTimeout: 30000, socketTimeout: 60000,
    });
    await transport.verify();
  }
  const args = [resolve(scanner, 'tradingview-signal-scanner.mjs'), 'scan',
    '--input', resolve(here, 'stocks.txt'), '--output-dir', runDir,
    '--speed', 'safe', '--switch-mode', 'url', '--passes', '2'];
  if (test) args.push('--max-symbols', '5', '--passes=1');
  const code = await new Promise((res, rej) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 4 * 60 * 60 * 1000);
    child.on('error', e => { clearTimeout(timeout); rej(e); });
    child.on('exit', c => { clearTimeout(timeout); res(c ?? 1); });
  });
  if (code !== 0) throw new Error(`Scanner exited with code ${code}; inspect ${runDir}`);
  const summary = JSON.parse(await readFile(resolve(runDir, 'TradingView-scan-summary-latest.json'), 'utf8'));
  if (!test && summary.stocks !== 997) throw new Error(`Expected 997 eligible stocks, received ${summary.stocks}. No result email sent.`);
  if (summary.ok === 0 || summary.ok + summary.errors !== summary.stocks) {
    throw new Error('Scan output is incomplete or contains no successfully checked stocks.');
  }
  const allSignals = parseCsv(await readFile(resolve(runDir, 'TradingView-signals-latest.csv'), 'utf8'));
  const todaySignals = allSignals.slice(1).filter((row) => row[6] === date);
  const todayPath = resolve(runDir, 'TradingView-signals-today.csv');
  await writeFile(todayPath, toCsv([allSignals[0], ...todaySignals]), 'utf8');
  if (test) {
    console.log(`Cloud test finished: ${summary.ok}/${summary.stocks} checked, ${todaySignals.length} current-date signals. No email sent. Check DataDate in: ${runDir}`);
  } else if (taipeiDate() === date) {
    await transport.sendMail({
      from: smtpUser,
      to: 'akenji0830@gmail.com',
      subject: `[TradingView] ${date} L1 / S Alpha：今日 ${todaySignals.length} 檔，讀取失敗 ${summary.errors} 檔${summary.errors ? '（結果未齊）' : ''}`,
      text: `本次掃描：${summary.stocks} 檔；成功 ${summary.ok} 檔；失敗 ${summary.errors} 檔。\n今日訊號附件只保留 DataDate = ${date} 的股票；舊日期訊號不算今日訊號。完整稽核與失敗清單亦附上。${summary.errors ? '\n注意：結果未齊，不能將未讀取的股票視為沒有訊號。' : ''}`,
      attachments: [
        { filename: 'TradingView-signals-today.csv', path: todayPath },
        ...['TradingView-scan-latest.csv', 'TradingView-errors-latest.csv'].map((filename) => ({ filename, path: resolve(runDir, filename) })),
      ],
    });
  }
} catch (error) {
  if (transport && taipeiDate() === date) {
    await transport.sendMail({ from: smtpUser, to: 'akenji0830@gmail.com',
      subject: `[TradingView] ${date} 掃描未完成`,
      text: '本次雲端掃描未完成，請查看主機執行紀錄。這不代表今日沒有訊號。',
    }).catch(() => console.error('Failure email also failed; inspect host logs.'));
  }
  throw error;
} finally {
  transport?.close();
  stopBrowser?.();
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
