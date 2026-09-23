import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCsv, normalizeRow, stableRead } from '../src/csv.js';
import { scan } from '../src/sync.js';
import { Store } from '../src/store.js';

test('invalid values and broken quoting are skipped without losing following sessions', () => {
  for (const separator of ['\n', '\r\n', '\r']) {
    const lines = [
      'date,time,house,count,',
      '20260917,08:00:00,2,500,',
      '20260230,08:01:00,2,10,',
      '20260917,25:00:00,2,10,',
      '20260917,08:02:00,house,10,',
      '20260917,08:03:00,2,-1,',
      '20260917,08:04:00,2,1.5,',
      '20260917,08:05:00,2',
      '20260917,08:06:00,2,10,unexpected',
      '20260917,08:07:00,2,"100',
      '20260917,08:08:00,2,10"0,',
      '',
      '   ',
      '"20260917","09:00:00","02","0",',
      '',
    ];
    let skipped = 0;
    const rows = parseCsv(Buffer.from(lines.join(separator)), 'utf-8', { onInvalidRow: () => skipped++ });
    assert.equal(skipped, 9);
    assert.deepEqual(rows, [
      normalizeRow(['20260917', '08:00:00', '2', '500']),
      normalizeRow(['20260917', '09:00:00', '2', '0']),
    ]);
  }
});

test('invalid encoding in one row does not block valid rows; unfinished final row waits', () => {
  let skipped = 0;
  const rows = parseCsv(Buffer.concat([
    Buffer.from('date,time,house,count,\n20260917,08:00:00,2,'),
    Buffer.from([0xff]),
    Buffer.from(',\n20260917,09:00:00,2,10,\n20260917,10:00:00,2,12'),
  ]), 'utf-8', { onInvalidRow: () => skipped++ });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].egg_count, 10);
  assert.equal(skipped, 1);
  assert.deepEqual(parseCsv(Buffer.from('header')), []);
  assert.deepEqual(parseCsv(Buffer.from('date,time,house,count,\ninvalid\n')), []);
});

test('scan reports skipped rows, leaves CSV intact, and accepts corrected rows on the next scan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abi-egg-csv-recovery-'));
  const store = new Store(':memory:');
  try {
    const csvPath = join(dir, 'day.csv');
    const source = 'date,time,house,count,\n20260917,08:00:00,2,500,\n20260917,09:00:00,2,bad,\n';
    await writeFile(csvPath, source);
    assert.deepEqual(await scan(store, { csvPath, encoding: 'utf-8' }), { scanned: 1, inserted: 1, skipped: 1 });
    assert.equal(await readFile(csvPath, 'utf8'), source);
    await writeFile(csvPath, source.replace(',bad,', ',600,'));
    assert.deepEqual(await scan(store, { csvPath, encoding: 'utf-8' }), { scanned: 2, inserted: 1, skipped: 0 });
    assert.equal(store.pending().length, 2);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('files larger than the former 20 MB limit are read without alteration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abi-egg-large-csv-'));
  try {
    const path = join(dir, 'large.csv');
    const content = Buffer.concat([
      Buffer.from('date,time,house,count,\n'),
      Buffer.alloc(21 * 1024 * 1024, ' '),
      Buffer.from('\n20260917,08:00:00,2,500,\n'),
    ]);
    await writeFile(path, content);
    const result = await stableRead(path, { settleMs: 1 });
    assert.ok(result.equals(content));
    assert.equal(parseCsv(result).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
