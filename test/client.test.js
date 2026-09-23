import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseCsv, normalizeRow, stableRead } from '../src/csv.js';
import { Store } from '../src/store.js';
import { sendPending } from '../src/sync.js';

const event = (count = '500', time = '08:00:00') => normalizeRow(['20260917', time, '02', count, '']);
const response = (id, status = 'accepted') => new Response(JSON.stringify({ event_id: id, status,
  ...(status === 'rejected' ? { code: 'SESSION_CONFLICT', issue_recorded: true } : {}) }), { status: 200 });
const config = { enabled: true, apiUrl: 'https://example.invalid/ingest' };

test('CLI scans twice without duplicates and sync defaults to disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abi-egg-cli-'));
  try {
    const file = join(dir, 'day.csv');
    const home = join(dir, 'data');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(home);
    await writeFile(file, 'date,time,house,count,\n20260917,08:00:00,2,500,\n');
    await writeFile(join(home, 'config.json'), JSON.stringify({ csvPath: file, encoding: 'utf-8', apiUrl: '', enabled: false, intervalSeconds: 300 }));
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const run = (command) => promisify(execFile)(process.execPath, [cli, command], {
      env: { ...process.env, ABI_EGG_HOME: home, ABI_EGG_CREDENTIAL: '' }, timeout: 15000,
    });
    assert.match((await run('scan')).stdout, /inserted: 1/);
    assert.match((await run('scan')).stdout, /inserted: 0/);
    const endpoint = 'http://127.0.0.1:5062/api/egg-counter-ai/sessions';
    await promisify(execFile)(process.execPath, [cli, 'set-endpoint', endpoint], { env: { ...process.env, ABI_EGG_HOME: home } });
    const saved = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    assert.equal(saved.apiUrl, endpoint);
    assert.equal(saved.enabled, false);
    assert.equal(saved.csvPath, file);
    await assert.rejects(run('enable'), error => error.stderr.includes('ABI_EGG_CREDENTIAL'));
    assert.match((await run('once')).stdout, /disabled: true/);
    assert.equal(JSON.parse((await run('status')).stdout).counts[0].count, 1);
    await rm(file);
    await assert.rejects(run('scan'), error => error.stderr.includes('File atau folder tidak ditemukan:') &&
      error.stderr.includes('day.csv') && !error.stderr.includes('Config belum tersedia'));
    const newFile = join(dir, 'replacement.csv');
    await writeFile(newFile, 'date,time,house,count,\n20260917,08:00:00,2,500,\n');
    await promisify(execFile)(process.execPath, [cli, 'set-csv', newFile], { env: { ...process.env, ABI_EGG_HOME: home } });
    assert.match((await run('scan')).stdout, /inserted: 0/);
    await rm(join(home, 'config.json'));
    await assert.rejects(run('scan'), error => error.stderr.includes('Config belum tersedia:'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('normalization makes deterministic IDs, preserves zeros and handles header/trailing column', () => {
  assert.deepEqual(event(), normalizeRow(['2026-09-17', '08:00:00', '2', '0500']));
  assert.notEqual(event().event_id, event('501').event_id);
  assert.equal(parseCsv(Buffer.from('date,time,house,count,\n20260917,08:00:00,2,0,\n'))[0].egg_count, 0);
  assert.deepEqual(parseCsv(Buffer.from('date,time,house,count,\n20260917,08:00:00,2,50')), []);
  assert.deepEqual(parseCsv(Buffer.from('')), []);
  assert.throws(() => parseCsv(Buffer.from('20260917,08:00:00,2,500,\n')), /Header/);
  assert.throws(() => normalizeRow(['20260230', '08:00:00', '2', '500']));
  assert.throws(() => normalizeRow(['20260917', '25:00:00', '2', '500']));
  assert.throws(() => event('-1'));
  assert.throws(() => event('1.2'));
});

test('stable read leaves the source untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abi-egg-test-'));
  try {
    const file = join(dir, 'day.csv');
    const data = Buffer.from('date,time,house,count,\n20260917,08:00:00,2,500,\n');
    await writeFile(file, data);
    assert.deepEqual(await stableRead(file, { settleMs: 1 }), data);
    await assert.rejects(stableRead(dir, { settleMs: 1 }), /bukan file biasa/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('outbox survives restart and CSV resets without duplicate insertions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abi-egg-test-'));
  let store;
  try {
    const db = join(dir, 'test.db');
    store = new Store(db);
    assert.equal(store.ingest([event(), event()]), 1);
    store.close(); store = new Store(db);
    assert.equal(store.ingest([event()]), 0);
    assert.equal(store.ingest([]), 0);
    assert.equal(store.ingest([event('10', '09:00:00')]), 1);
    assert.equal(store.pending().length, 2);
    store.sent(event().event_id);
    assert.equal(store.ingest([event()]), 0);
    assert.equal(store.pending().length, 1);
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('changed count on same session is held for review, never added automatically', () => {
  const store = new Store(':memory:');
  try {
    store.ingest([event(), event('550')]);
    assert.equal(store.pending().length, 0);
    assert.equal(store.status().counts[0].status, 'needs_review');
    assert.throws(() => store.retry(event('550').event_id), /Konflik/);
  } finally { store.close(); }
});

test('ingestion is atomic on malformed record', () => {
  const store = new Store(':memory:');
  try {
    assert.throws(() => store.ingest([event(), { ...event('501'), egg_count: -1 }]));
    assert.equal(store.pending().length, 0);
  } finally { store.close(); }
});

test('disabled transmission never contacts API', async () => {
  const store = new Store(':memory:');
  try {
    store.ingest([event()]);
    await sendPending(store, { enabled: false }, '', () => assert.fail('Unexpected API call'));
    assert.equal(store.pending().length, 1);
  } finally { store.close(); }
});

test('status includes failed older events independently of the recent list', () => {
  const store = new Store(':memory:');
  try {
    const old = event();
    store.ingest([old]);
    store.db.prepare('UPDATE outbox SET created_at=? WHERE event_id=?').run('2020-01-01', old.event_id);
    store.ingest(Array.from({ length: 12 }, (_, i) => event(String(i), `09:${String(i).padStart(2, '0')}:00`)));
    store.attempt(old.event_id);
    store.failed(old.event_id, 'HTTP 401; belum dikonfirmasi server.');
    const status = store.status();
    assert.ok(!status.recent.some(row => row.event_id === old.event_id));
    assert.equal(status.errors[0].event_id, old.event_id);
    assert.equal(status.errors[0].attempt_count, 1);
    assert.match(status.errors[0].last_error, /401/);
    assert.ok(status.errors[0].next_attempt_at);
  } finally { store.close(); }
});

test('accepted and duplicate acknowledgment mark sent; same event identity on retry', async () => {
  const store = new Store(':memory:');
  try {
    store.ingest([event()]);
    await sendPending(store, config, 'secret', async () => { throw new Error('secret'); });
    assert.equal(store.pending().length, 0); // Backoff is active.
    assert.equal(store.status().recent[0].status, 'pending');
    assert.ok(!store.status().recent[0].last_error.includes('secret'));
    store.retry(event().event_id);
    await sendPending(store, config, 'secret', async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer secret');
      assert.equal(options.redirect, 'error');
      assert.equal(JSON.parse(options.body).event_id, event().event_id);
      return response(event().event_id, 'duplicate');
    });
    assert.equal(store.status().recent[0].status, 'sent');
    assert.equal(store.status().recent[0].attempt_count, 2);
    assert.throws(() => store.retry(event().event_id));
    store.ingest([event('20', '09:00:00')]);
    await sendPending(store, config, 'secret', async () => response(event('20', '09:00:00').event_id));
    assert.ok(store.status().recent.every(row => row.status === 'sent'));
  } finally { store.close(); }
});

test('invalid ack, auth errors and server failures stay pending; rejection needs review', async () => {
  for (const kind of ['invalid', '401', '429', '500', 'rejected']) {
    const store = new Store(':memory:');
    try {
      store.ingest([event()]);
      await sendPending(store, config, 'secret', async () => {
        if (kind === 'invalid') return response('another-event');
        if (kind === 'rejected') return response(event().event_id, kind);
        return new Response('', { status: Number(kind) });
      });
      assert.equal(store.status().recent[0].status, kind === 'rejected' ? 'needs_review' : 'pending');
    } finally { store.close(); }
  }
});

test('timeout and invalid acknowledgment have distinct safe diagnostic messages', async () => {
  for (const kind of ['timeout', 'ack']) {
    const store = new Store(':memory:');
    try {
      store.ingest([event()]);
      await sendPending(store, config, 'secret', async () => {
        if (kind === 'timeout') throw Object.assign(new Error('secret'), { name: 'TimeoutError' });
        return response('different-id');
      });
      const error = store.status().errors[0];
      assert.equal(error.status, 'pending');
      assert.match(error.last_error, kind === 'timeout' ? /Timeout 15 detik/ : /event_id\/status tidak cocok/);
      assert.ok(!error.last_error.includes('secret'));
    } finally { store.close(); }
  }
});

test('rejection reasons are persisted without recording arbitrary remote text', async () => {
  for (const code of ['MAPPING_MISSING_OR_AMBIGUOUS', 'FLOCK_SOURCE_NOT_AI', 'SESSION_CONFLICT', 'secret']) {
    const store = new Store(':memory:');
    try {
      store.ingest([event()]);
      await sendPending(store, config, 'secret', async () => new Response(JSON.stringify({
        event_id: event().event_id, status: 'rejected', code, message: 'secret', issue_recorded: true,
      })));
      const error = store.status().errors[0];
      assert.equal(error.status, ['MAPPING_MISSING_OR_AMBIGUOUS', 'FLOCK_SOURCE_NOT_AI'].includes(code) ? 'pending' : 'needs_review');
      assert.ok(!error.last_error.includes('secret'));
      if (code !== 'secret') assert.ok(error.last_error.includes(code));
    } finally { store.close(); }
  }
});
