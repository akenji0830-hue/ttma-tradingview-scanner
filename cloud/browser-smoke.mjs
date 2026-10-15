// Verify the real hosted Chrome binary without logging into TradingView,
// opening a chart, scanning any stocks, or sending mail.
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startBrowserWithSession } from './tradingview-session.mjs';

const stop = await startBrowserWithSession({
  chromePath: process.env.TV_SIGNAL_CHROME_PATH,
  profileDirectory: resolve(process.env.RUNNER_TEMP || tmpdir(), 'ttma-smoke-profile'),
  port: 9324,
  encodedCookies: Buffer.from(JSON.stringify([
    { name: 'ttma_smoke_probe', value: 'not-an-authentication-cookie', domain: '.tradingview.com', expires: -1 },
  ])).toString('base64'),
});
await stop();
console.log('Hosted Chrome startup smoke test passed. No TradingView login, chart, stock scan, or email used.');
