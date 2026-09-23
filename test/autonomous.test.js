import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { normalizeRow } from '../src/csv.js';
import { sendPending } from '../src/sync.js';

const event = (count = '500', time = '08:00:00') => normalizeRow(['20240917', time, '2', count]);
const config = { enabled: true, apiUrl: 'http://127.0.0.1:5062/api/egg-counter-ai/sessions' };
const ack = (row, status, code, extra = {}) => new Response(JSON.stringify({ event_id: row.event_id, status, code, ...extra }));
const find = (store, row) => store.db.prepare('SELECT * FROM outbox WHERE event_id=?').get(row.event_id);

test('mapping retry is hourly, other events proceed, corrected mapping needs no client intervention', async () => {
  const store = new Store(':memory:');
  const first = event();
  const second = event('10', '09:00:00');
  try {
    store.ingest([first, second]);
    const before = Date.now();
    const result = await sendPending(store, config, 'secret', async (url, options) => {
      const row = JSON.parse(options.body);
      return row.event_id === first.event_id
        ? ack(row, 'retry', 'MAPPING_DATE_MISMATCH', { issue_recorded: true }) : ack(row, 'accepted');
    });
    assert.equal(result.deferred, 1);
    assert.equal(result.sent, 1);
    assert.equal(find(store, first).status, 'pending');
    assert.ok(Date.parse(find(store, first).next_attempt_at) >= before + 3600000);
    await sendPending(store, config, 'secret', () => assert.fail('Backoff must be respected'));
    // Advance only the test queue clock to simulate the next hourly retry.
    store.db.prepare("UPDATE outbox SET next_attempt_at='2000-01-01' WHERE event_id=?").run(first.event_id);
    await sendPending(store, config, 'secret', async () => ack(first, 'accepted'));
    assert.equal(find(store, first).status, 'sent');
    assert.equal(find(store, first).attempt_count, 2);
  } finally { store.close(); }
});

test('unmapped houses are ignored persistently, rescanning does not resubmit them', async () => {
  const store = new Store(':memory:');
  const row = event();
  try {
    store.ingest([row]);
    const result = await sendPending(store, config, 'secret', async () => ack(row, 'ignored', 'HOUSE_UNMAPPED'));
    assert.equal(result.ignored, 1);
    assert.equal(find(store, row).status, 'ignored');
    assert.equal(store.ingest([row]), 0);
    await sendPending(store, config, 'secret', () => assert.fail('Ignored rows must not be sent'));
  } finally { store.close(); }
});

test('legacy rejection without central confirmation retries instead of requiring client review', async () => {
  const store = new Store(':memory:');
  const row = event();
  try {
    store.ingest([row]);
    await sendPending(store, config, 'secret', async () => ack(row, 'rejected', 'SESSION_CONFLICT'));
    assert.equal(find(store, row).status, 'pending');
    assert.ok(find(store, row).next_attempt_at);
  } finally { store.close(); }
});

test('local conflicts use report-only endpoint; reporting failure retries but never sends production', async () => {
  const store = new Store(':memory:');
  const rows = [event(), event('600')];
  try {
    store.ingest(rows);
    await sendPending(store, config, 'secret', async url => {
      assert.equal(new URL(url).pathname, '/api/egg-counter-ai/issues');
      return new Response('', { status: 404 }); // Old server cannot accidentally accept a report as production.
    });
    assert.equal(store.status().counts[0].status, 'needs_review');
    assert.equal(store.status().counts[0].count, 2);
    assert.ok(rows.every(row => find(store, row).report_pending === 1));
    store.db.exec('UPDATE outbox SET next_attempt_at=NULL');
    const result = await sendPending(store, config, 'secret', async (url, options) => {
      assert.equal(new URL(url).pathname, '/api/egg-counter-ai/issues');
      const row = JSON.parse(options.body);
      assert.equal(row.report_only, true);
      assert.equal(row.client_issue, 'LOCAL_SESSION_CONFLICT');
      return ack(row, 'rejected', 'LOCAL_SESSION_CONFLICT', { issue_recorded: true });
    });
    assert.equal(result.reported, 2);
    assert.equal(result.sent, 0);
    assert.equal(store.deliverable().length, 0);
    assert.ok(rows.every(row => find(store, row).report_pending === 0));
    assert.throws(() => store.retry(rows[0].event_id), /Konflik/);
  } finally { store.close(); }
});

test('a successful-looking response cannot mark a local correction sent', async () => {
  const store = new Store(':memory:');
  const row = event();
  try {
    store.ingest([row]);
    store.sent(row.event_id);
    const correction = event('501');
    store.ingest([correction]);
    await sendPending(store, config, 'secret', async () => ack(correction, 'accepted'));
    assert.equal(find(store, row).status, 'sent');
    assert.equal(find(store, correction).status, 'needs_review');
    assert.equal(find(store, correction).report_pending, 1);
    assert.ok(find(store, correction).next_attempt_at);
  } finally { store.close(); }
});

test('v1 SQLite migration preserves sent data and retries legacy rejections while holding conflicts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abi-egg-migrate-'));
  let store;
  try {
    const path = join(dir, 'queue.db');
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE outbox (
      event_id TEXT PRIMARY KEY,source_house_number TEXT NOT NULL,recorded_at TEXT NOT NULL,
      egg_count INTEGER NOT NULL CHECK(egg_count>=0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','needs_review')),
      attempt_count INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at TEXT NOT NULL,sent_at TEXT,next_attempt_at TEXT
    );`);
    const sent = event('50', '07:00:00');
    const mapped = event();
    const conflicts = [event('20', '09:00:00'), event('30', '09:00:00')];
    const insert = db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?,?,?,?,?)');
    for (const row of [sent, mapped, ...conflicts]) {
      const isSent = row.event_id === sent.event_id;
      insert.run(row.event_id, row.source_house_number, row.recorded_at, row.egg_count,
        isSent ? 'sent' : 'needs_review', 3, isSent ? null : 'Server menolak data',
        '2024-09-17T01:00:00Z', isSent ? '2024-09-17T01:01:00Z' : null, null);
    }
    db.close();
    store = new Store(path);
    assert.equal(find(store, sent).status, 'sent');
    assert.equal(find(store, sent).sent_at, '2024-09-17T01:01:00Z');
    assert.equal(find(store, sent).attempt_count, 3);
    assert.equal(find(store, mapped).status, 'pending');
    assert.ok(conflicts.every(row => find(store, row).local_conflict === 1 && find(store, row).report_pending === 1));
    assert.equal(store.ingest([sent, mapped, ...conflicts]), 0);
    store.disposition(mapped.event_id, 'ignored', 'HOUSE_UNMAPPED', 'Skipped');
    store.close(); store = new Store(path);
    assert.equal(find(store, mapped).status, 'ignored');
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 4);
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});
