import { DatabaseSync } from 'node:sqlite';

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY,
        source_house_number TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        egg_count INTEGER NOT NULL CHECK(egg_count >= 0),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','needs_review','ignored')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        next_attempt_at TEXT,
        reason_code TEXT,
        local_conflict INTEGER NOT NULL DEFAULT 0,
        report_pending INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS outbox_session ON outbox(source_house_number, recorded_at);`);
    this.migrate();
  }
  migrate() {
    if (this.db.prepare('PRAGMA user_version').get().user_version >= 2) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db.prepare('PRAGMA table_info(outbox)').all();
      if (!columns.some(row => row.name === 'reason_code')) {
        // SQLite cannot extend a CHECK constraint in place. Copy every event in one transaction.
        this.db.exec(`ALTER TABLE outbox RENAME TO outbox_v1;
          CREATE TABLE outbox (
            event_id TEXT PRIMARY KEY, source_house_number TEXT NOT NULL, recorded_at TEXT NOT NULL,
            egg_count INTEGER NOT NULL CHECK(egg_count>=0),
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','needs_review','ignored')),
            attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL,
            sent_at TEXT, next_attempt_at TEXT, reason_code TEXT,
            local_conflict INTEGER NOT NULL DEFAULT 0, report_pending INTEGER NOT NULL DEFAULT 0
          );
          INSERT INTO outbox(event_id,source_house_number,recorded_at,egg_count,status,attempt_count,last_error,created_at,sent_at,next_attempt_at)
            SELECT event_id,source_house_number,recorded_at,egg_count,status,attempt_count,last_error,created_at,sent_at,next_attempt_at FROM outbox_v1;
          DROP TABLE outbox_v1;
          CREATE INDEX outbox_status ON outbox(status,next_attempt_at);
          CREATE INDEX outbox_session ON outbox(source_house_number,recorded_at);`);
      }
      this.db.exec(`UPDATE outbox SET local_conflict=1, report_pending=1,
          reason_code='LOCAL_SESSION_CONFLICT', next_attempt_at=NULL
        WHERE status='needs_review' AND (
          last_error IN ('Jumlah berbeda untuk kandang dan waktu yang sama.', 'Kemungkinan koreksi data lama; periksa sebelum mengirim.')
          OR EXISTS (SELECT 1 FROM outbox other WHERE other.source_house_number=outbox.source_house_number
            AND other.recorded_at=outbox.recorded_at AND other.egg_count<>outbox.egg_count));
        UPDATE outbox SET status='pending',next_attempt_at=NULL
          WHERE status='needs_review' AND local_conflict=0;
        PRAGMA user_version=2;
        COMMIT;`);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
  ingest(records) {
    let inserted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of records) {
        if (this.db.prepare('SELECT 1 FROM outbox WHERE event_id=?').get(row.event_id)) continue;
        const conflict = this.db.prepare('SELECT 1 FROM outbox WHERE source_house_number=? AND recorded_at=? AND egg_count<>?')
          .get(row.source_house_number, row.recorded_at, row.egg_count);
        if (conflict) this.db.prepare("UPDATE outbox SET status='needs_review', local_conflict=1, report_pending=1, next_attempt_at=NULL, reason_code='LOCAL_SESSION_CONFLICT', last_error='Jumlah berbeda untuk kandang dan waktu yang sama.' WHERE source_house_number=? AND recorded_at=? AND status<>'sent'")
          .run(row.source_house_number, row.recorded_at);
        this.db.prepare('INSERT INTO outbox(event_id,source_house_number,recorded_at,egg_count,status,last_error,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(row.event_id, row.source_house_number, row.recorded_at, row.egg_count,
            conflict ? 'needs_review' : 'pending', conflict ? 'Kemungkinan koreksi data lama; periksa sebelum mengirim.' : null, new Date().toISOString());
        if (conflict) this.db.prepare("UPDATE outbox SET local_conflict=1,report_pending=1,reason_code='LOCAL_SESSION_CONFLICT' WHERE event_id=?").run(row.event_id);
        inserted++;
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return inserted;
  }
  pending(limit = 100) {
    return this.db.prepare("SELECT * FROM outbox WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY recorded_at,event_id LIMIT ?")
      .all(new Date().toISOString(), limit);
  }
  deliverable(limit = 100) {
    return this.db.prepare(`SELECT * FROM outbox WHERE (status='pending' OR report_pending=1)
      AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY recorded_at,event_id LIMIT ?`)
      .all(new Date().toISOString(), limit);
  }
  attempt(id) { this.db.prepare('UPDATE outbox SET attempt_count=attempt_count+1 WHERE event_id=?').run(id); }
  sent(id) {
    this.db.prepare("UPDATE outbox SET status='sent', sent_at=?, last_error=NULL, reason_code=NULL, report_pending=0, next_attempt_at=NULL WHERE event_id=? AND local_conflict=0")
      .run(new Date().toISOString(), id);
  }
  failed(id, message, review = false, attempts = 1) {
    const delay = Math.min(3600000, 300000 * 2 ** Math.min(attempts - 1, 4));
    this.db.prepare("UPDATE outbox SET status=CASE WHEN local_conflict=1 THEN 'needs_review' ELSE ? END,last_error=?,next_attempt_at=? WHERE event_id=?")
      .run(review ? 'needs_review' : 'pending', message, new Date(Date.now() + delay).toISOString(), id);
  }
  disposition(id, status, code, message, retrySeconds = null) {
    this.db.prepare('UPDATE outbox SET status=?,reason_code=?,last_error=?,report_pending=0,next_attempt_at=? WHERE event_id=?')
      .run(status, code, message, retrySeconds === null ? null : new Date(Date.now() + retrySeconds * 1000).toISOString(), id);
  }
  retry(id) {
    const row = this.db.prepare('SELECT * FROM outbox WHERE event_id=?').get(id);
    if (!row || row.status === 'sent') throw new Error('Event tidak ditemukan atau sudah terkirim.');
    const conflict = this.db.prepare('SELECT 1 FROM outbox WHERE source_house_number=? AND recorded_at=? AND event_id<>?')
      .get(row.source_house_number, row.recorded_at, id);
    if (conflict) throw new Error('Konflik sesi harus direkonsiliasi dengan server; retry otomatis ditolak.');
    this.db.prepare("UPDATE outbox SET status='pending',last_error=NULL,next_attempt_at=NULL WHERE event_id=?").run(id);
  }
  status() {
    return {
      counts: this.db.prepare('SELECT status,COUNT(*) AS count FROM outbox GROUP BY status').all(),
      errors: this.db.prepare(`SELECT event_id,recorded_at,source_house_number,status,attempt_count,last_error,reason_code,report_pending,next_attempt_at
        FROM outbox WHERE last_error IS NOT NULL
        ORDER BY next_attempt_at DESC,event_id LIMIT 10`).all(),
      recent: this.db.prepare('SELECT event_id,recorded_at,source_house_number,egg_count,status,attempt_count,last_error FROM outbox ORDER BY created_at DESC LIMIT 10').all(),
    };
  }
}
