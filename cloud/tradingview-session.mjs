import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withRecovery, stopChild, sleep } from './reliability.mjs';

const allowedDomain = (domain) => /(^|\.)tradingview\.com$/i.test(String(domain).replace(/^\./, ''));

export function decodeSession(value) {
  if (!value) throw new Error('Missing TV_SESSION_COOKIES_B64. Do not put TradingView cookies in source code.');
  let cookies;
  try {
    cookies = JSON.parse(Buffer.from(value.trim(), 'base64').toString('utf8'));
  } catch {
    throw new Error('TV_SESSION_COOKIES_B64 is not valid base64 JSON.');
  }
  if (!Array.isArray(cookies) || !cookies.length || cookies.length > 250 ||
      cookies.some((cookie) => !allowedDomain(cookie.domain) || !cookie.name || typeof cookie.value !== 'string')) {
    throw new Error('Session must contain only TradingView cookies.');
  }
  return cookies;
}

export async function requestCdp(webSocketUrl, method, params = {}) {
  const socket = new WebSocket(webSocketUrl);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome CDP connection timed out')), 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome CDP connection failed')); }, { once: true });
    });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10000);
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method} failed: ${message.error.message}`));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    socket.close();
  }
}

export async function waitForChrome(port, { child, timeoutMs = 60000, fetcher = fetch, pause = sleep, clock = Date.now } = {}) {
  const deadline = clock() + timeoutMs;
  while (clock() < deadline) {
    if (child?.startupError) throw child.startupError;
    if (child && (child.exitCode != null || child.signalCode != null)) {
      throw new Error(`Chrome exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode}).`);
    }
    try {
      const response = await fetcher(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Chrome is starting. */ }
    await pause(250);
  }
  throw new Error('Headless Chrome did not start.');
}

export async function startBrowserWithSession({ chromePath, profileDirectory, port, encodedCookies }, {
  spawnProcess = spawn, createProfile = async () => {
    await mkdir(dirname(profileDirectory), { recursive: true });
    return mkdtemp(`${profileDirectory}-`);
  }, waitForStartup = waitForChrome, fetcher = fetch, cdp = requestCdp,
  stop = stopChild, pause = sleep,
} = {}) {
  const cookies = decodeSession(encodedCookies);
  const nowSeconds = Date.now() / 1000;
  const validCookies = cookies.filter((cookie) => !cookie.expires || cookie.expires < 0 || cookie.expires > nowSeconds);
  if (!validCookies.length || cookies.some((cookie) => cookie.name === 'sessionid' && cookie.expires > 0 && cookie.expires <= nowSeconds)) {
    const error = new Error('TradingView login cookies have expired. Export a fresh session.');
    error.code = 'AUTH_REQUIRED';
    throw error;
  }
  return withRecovery(async (attempt) => {
  const freshProfile = await createProfile();
  const child = spawnProcess(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${freshProfile}`,
    '--headless=new',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let startupLog = '';
  child.once('error', (error) => { child.startupError = error; });
  child.stderr?.on('data', (chunk) => { startupLog = `${startupLog}${chunk}`.slice(-4000); });
  try {
    console.log(`Starting Chrome (attempt ${attempt}/3, up to 60s).`);
    await waitForStartup(port, { child });
    const response = await fetcher(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: 'PUT', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Cannot create Chrome page for session restore.');
    const target = await response.json();
    const params = validCookies.map((cookie) => {
      const output = {
        name: cookie.name, value: cookie.value, path: cookie.path || '/',
        secure: Boolean(cookie.secure), httpOnly: Boolean(cookie.httpOnly),
      };
      if (cookie.name.startsWith('__Host-')) output.url = 'https://www.tradingview.com/';
      else output.domain = cookie.domain;
      if (cookie.sameSite && ['Strict', 'Lax', 'None'].includes(cookie.sameSite)) output.sameSite = cookie.sameSite;
      if (cookie.expires > 0) output.expires = cookie.expires;
      return output;
    });
    await cdp(target.webSocketDebuggerUrl, 'Network.setCookies', { cookies: params });
    console.log(`Restored ${params.length} TradingView cookies into a temporary browser profile.`);
    return () => stop(child);
  } catch (error) {
    await stop(child);
    const safeLog = startupLog.replace(/(?:https?|wss?):\/\/\S+/g, '[URL]').slice(-2000);
    if (safeLog) console.warn(`Chrome startup diagnostic: ${safeLog}`);
    throw error;
  }
  }, { attempts: 3, pause, onRetry: (error) => console.warn(`Chrome startup failed; retrying with a fresh temporary profile: ${error.message}`) });
}
