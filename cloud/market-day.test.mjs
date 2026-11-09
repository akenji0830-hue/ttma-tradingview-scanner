import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { calendarStatus, marketDayStatus, taipeiDate } from './market-day.mjs';

// Dates and names from the TWSE 115-year holidaySchedule API (2026-10-04).
const calendar = [
  ['1150101', '中華民國開國紀念日'], ['1150102', '國曆新年開始交易日'],
  ['1150211', '農曆春節前最後交易日'],
  ['1150212', '市場無交易，僅辦理結算交割作業'],
  ['1150213', '市場無交易，僅辦理結算交割作業'],
  ...['15', '16', '17', '18', '19', '20'].map((day) => [`11502${day}`, '農曆除夕及春節']),
  ['1150223', '農曆春節後開始交易日'],
  ['1150227', '和平紀念日'], ['1150228', '和平紀念日'],
  ...['03', '04', '05', '06'].map((day) => [`11504${day}`, '兒童節及民族掃墓節']),
  ['1150501', '勞動節'], ['1150619', '端午節'], ['1150925', '中秋節'],
  ['1150928', '孔子誕辰紀念日/ 教師節'], ['1151009', '國慶日'], ['1151010', '國慶日'],
  ['1151025', '臺灣光復暨金門古寧頭大捷紀念日'],
  ['1151026', '臺灣光復暨金門古寧頭大捷紀念日'], ['1151225', '行憲紀念日'],
].map(([Date, Name]) => ({ Date, Name }));

const at = (date) => new Date(`${date}T13:32:00+08:00`);
const quote = (date = '20261005', overrides = {}) => ({
  rtcode: '0000', queryTime: { sysDate: '20261005' },
  msgArray: [{ c: '2330', ex: 'tse', d: date, v: '10000', t: '13:30:00', ...overrides }],
});
const fakeFetch = (quotes = quote()) => async (url) => ({
  ok: true, json: async () => url.includes('holidaySchedule') ? calendar : quotes,
});

test('uses Taipei date across UTC midnight and host locale', () => {
  assert.equal(taipeiDate(new Date('2026-10-04T16:01:00Z')), '2026-10-05');
});

for (const date of ['2026-10-03', '2026-10-04']) {
  test(`weekend ${date} performs no network, scan, or email`, async () => {
    const result = await marketDayStatus({ now: at(date), fetcher: () => { throw new Error('Unexpected fetch'); } });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'Weekend');
  });
}

for (const date of ['2026-02-12', '2026-02-13', '2026-02-20', '2026-04-03',
  '2026-09-25', '2026-09-28', '2026-10-09', '2026-10-26', '2026-12-25']) {
  test(`TWSE closure ${date} never requests quotes`, async () => {
    let calls = 0;
    const status = await marketDayStatus({ now: at(date), fetcher: async () => {
      calls += 1;
      return { ok: true, json: async () => calendar };
    } });
    assert.equal(status.allowed, false);
    assert.equal(calls, 1);
  });
}

test('new-year opening, spring final/opening sessions are not holidays', () => {
  for (const date of ['2026-01-02', '2026-02-11', '2026-02-23']) {
    assert.equal(calendarStatus(date, calendar).allowed, true);
  }
});

test('confirmed current-date closing trade permits the Monday scan', async () => {
  const status = await marketDayStatus({ now: at('2026-10-05'), fetcher: fakeFetch() });
  assert.equal(status.allowed, true);
});

test('temporary/typhoon closure with prior-session quotes is blocked', async () => {
  const status = await marketDayStatus({ now: at('2026-10-05'), fetcher: fakeFetch(quote('20261002')) });
  assert.equal(status.allowed, false);
});

for (const [name, data] of [
  ['stale response', { ...quote(), queryTime: { sysDate: '20261002' } }],
  ['no trades', quote('20261005', { v: '0' })],
  ['before close', quote('20261005', { t: '13:29:59' })],
  ['wrong instrument', quote('20261005', { c: '0000' })],
  ['wrong market', quote('20261005', { ex: 'otc' })],
  ['empty records', { ...quote(), msgArray: [] }],
]) {
  test(`${name} cannot authorize a scan`, async () => {
    assert.equal((await marketDayStatus({ now: at('2026-10-05'), fetcher: fakeFetch(data) })).allowed, false);
  });
}

test('expired-year or incomplete calendars fail closed', () => {
  assert.throws(() => calendarStatus('2027-01-04', calendar), /does not cover/);
  assert.throws(() => calendarStatus('2026-10-05', calendar.slice(-2)), /does not cover/);
  assert.throws(() => calendarStatus('2026-10-05', [{}]), /calendar date/);
});

test('unavailable official API retries twice then never authorizes a scan', async () => {
  let calls = 0;
  await assert.rejects(() => marketDayStatus({ now: at('2026-10-05'), fetcher: async () => {
    calls += 1; throw new Error('Unavailable');
  } }), /Unavailable/);
  assert.equal(calls, 2);
});

test('invalid quote response fails closed', async () => {
  await assert.rejects(() => marketDayStatus({ now: at('2026-10-05'), fetcher: fakeFetch({ rtcode: '5000' }) }), /Invalid TWSE/);
});

test('runner checks market day before credentials/browser/mail initialization', async () => {
  const source = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('const marketDay = await withRecovery(() => marketDayStatus())') < source.indexOf('const smtpUser'));
  assert.ok(source.indexOf('process.exit(0)') < source.indexOf('await startBrowserWithSession('));
  assert.match(source, /if \(remaining < 30000 \|\| taipeiDate\(\) !== date\)/);
});
