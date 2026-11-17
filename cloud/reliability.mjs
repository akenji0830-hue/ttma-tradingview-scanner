import { spawn } from 'node:child_process';
import { appendFile, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marketDayStatus, taipeiDate } from './market-day.mjs';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function permanentFailure(error) {
  return /AUTH_REQUIRED|BUDGET|Missing |not valid base64|Session must contain|expired|尚未登入|沒有使用權限|無使用權限|EAUTH|535|Invalid login/i
    .test(`${error?.code ?? ''} ${error?.message ?? error}`);
}

export async function withRecovery(operation, {
  attempts = 3, delayMs = 5000, pause = sleep, onRetry = () => {},
  retryable = (error) => !permanentFailure(error),
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(attempt); }
    catch (error) {
      if (attempt === attempts || !retryable(error)) throw error;
      onRetry(error, attempt);
      await pause(delayMs * attempt);
    }
  }
}

export async function stopChild(child, { graceMs = 5000 } = {}) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  await new Promise((resolve) => {
    let killTimer, deadline;
    const done = () => { clearTimeout(killTimer); clearTimeout(deadline); resolve(); };
    child.once('close', done);
    killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    deadline = setTimeout(done, graceMs + 1000);
    child.kill('SIGTERM');
  });
}

export function runScanner(args, {
  env = process.env, spawnProcess = spawn, idleMs = 10 * 60 * 1000,
  timeoutMs = 125 * 60 * 1000, log = (chunk, isError) =>
    (isError ? process.stderr : process.stdout).write(chunk),
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
    let idleTimer, totalTimer, killTimer, tail = '', reason = '', settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer); clearTimeout(totalTimer); clearTimeout(killTimer);
      if (error) reject(error); else resolve({ code, tail });
    };
    const abort = (message) => {
      if (reason || settled) return;
      reason = message;
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error(message));
      }, 5000);
      child.kill('SIGTERM');
    };
    const heartbeat = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abort('Scanner made no progress for 10 minutes'), idleMs);
    };
    const output = (chunk, isError) => {
      if (settled) return;
      tail = `${tail}${chunk}`.slice(-5000);
      log(chunk, isError);
      heartbeat();
    };
    child.stdout.on('data', (chunk) => output(chunk, false));
    child.stderr.on('data', (chunk) => output(chunk, true));
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (reason) finish(new Error(reason));
      else if (code !== 0) finish(new Error(`Scanner exited with code ${code}: ${tail.slice(-1200)}`));
      else finish(null, code);
    });
    heartbeat();
    totalTimer = setTimeout(() => abort('Scanner exceeded its attempt time budget'), timeoutMs);
  });
}

const here = dirname(fileURLToPath(import.meta.url));
export const recipient = 'akenji0830@gmail.com';

export async function createMailer() {
  if (!process.env.SMTP_PASS) throw new Error('Missing SMTP_PASS');
  const { default: nodemailer } = await import('nodemailer');
  const port = Number(process.env.SMTP_PORT || 465);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com', port, secure: port === 465,
    requireTLS: true, auth: { user: process.env.SMTP_USER || recipient, pass: process.env.SMTP_PASS },
    connectionTimeout: 30000, socketTimeout: 60000,
  });
}

export async function output(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export function validDelivery(marker, date) {
  return marker?.date === date && marker.sent === true && Number.isInteger(marker.stocks) && marker.stocks >= 995 &&
      Number.isInteger(marker.ok) && marker.ok > 0 && marker.ok <= marker.stocks &&
    Number.isInteger(marker.errors) && marker.errors >= 0 && marker.ok + marker.errors === marker.stocks;
}

export async function saveDelivery(date, summary, info) {
  if (!info?.accepted?.some((address) => String(address).toLowerCase() === recipient)) {
    throw new Error('SMTP did not accept the result recipient');
  }
  const marker = { date, sent: true, stocks: summary.stocks, ok: summary.ok, errors: summary.errors,
    runId: process.env.GITHUB_RUN_ID || 'local', sentAt: new Date().toISOString() };
  if (!validDelivery(marker, date)) throw new Error('Cannot mark incomplete scan as delivered');
  await mkdir(resolve(here, 'delivery'), { recursive: true });
  await writeFile(resolve(here, 'delivery', `${date}.json`), JSON.stringify(marker), 'utf8');
  console.log(`Report email accepted by SMTP for ${date}.`);
}

export async function notifyFailure({ statusFn = marketDayStatus, mailerFactory = createMailer, now = new Date() } = {}) {
  const date = taipeiDate(now);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6 || (process.env.REPORT_DATE && process.env.REPORT_DATE !== date)) return;
  const confirmed = process.env.MARKET_CONFIRMED === 'true' && process.env.REPORT_DATE === date;
  if (!confirmed && !(await statusFn({ now })).allowed) return;
  const transport = await mailerFactory();
  try {
    const runUrl = `https://github.com/akenji0830-hue/ttma-tradingview-scanner/actions/runs/${process.env.GITHUB_RUN_ID || ''}`;
    await withRecovery(() => transport.sendMail({
      from: process.env.SMTP_USER || recipient, to: recipient,
      subject: `[TradingView] ${date} 掃描未完成，需確認`,
      text: `今天的掃描或寄信未完成，這不代表沒有 L1 / S Alpha 訊號。\n系統會在當日備援檢查時自動補救，最多三次雲端工作嘗試；登入過期、權限或免費額度不足仍需人工處理。\n查看紀錄：${runUrl}\n${(process.env.NOTICE || '').slice(0,500)}`,
      messageId: `<ttma-failure-${date}-${process.env.GITHUB_RUN_ID || Date.now()}-${process.env.GITHUB_RUN_ATTEMPT || 1}@ttma-scanner.invalid>`,
    }), { attempts: 2 });
    console.log('Failure notification accepted by SMTP.');
  } finally { transport.close(); }
}

async function cli() {
  if (process.argv[2] === 'notify') return notifyFailure();
  if (process.argv[2] === 'day') {
    const status = await withRecovery(() => marketDayStatus(), { attempts: 3 });
    console.log(`Market day ${status.date}: ${status.reason}`);
    const expected = process.env.REQUESTED_SCAN_DATE;
    const allowed = status.allowed && (!expected || expected === status.date);
    await output('date', status.date);
    await output('allowed', String(allowed));
  } else if (['check-marker', 'require-marker'].includes(process.argv[2])) {
    const date = taipeiDate();
    let marker;
    try { marker = JSON.parse(await readFile(resolve(here, 'delivery', `${date}.json`), 'utf8')); } catch {}
    const delivered = validDelivery(marker, date);
    console.log(delivered ? 'Today was already scanned and mailed; skipping duplicate.' : 'No accepted report marker for today.');
    await output('delivered', String(delivered));
    if (process.argv[2] === 'require-marker' && !delivered) throw new Error('No confirmed report delivery for today. This run is not a successful scan.');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli();
