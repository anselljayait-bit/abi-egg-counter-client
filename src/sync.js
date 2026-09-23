import { parseCsv, stableRead } from './csv.js';
import { validateEndpoint } from './endpoint.js';

const rejectionMessages = new Map([
  ['MAPPING_MISSING_OR_AMBIGUOUS', 'Mapping kandang/flock untuk tanggal sesi tidak ditemukan atau lebih dari satu. Periksa farm, nomor CSV, valid_from dan valid_until.'],
  ['FLOCK_SOURCE_NOT_AI', 'egg_source pada flock tujuan bukan ai.'],
  ['SESSION_CONFLICT', 'Sudah ada sesi pada flock dan waktu yang sama; perlu rekonsiliasi, bukan penambahan ulang.'],
  ['INVALID_EVENT', 'Struktur data sesi tidak valid.'],
  ['INVALID_EVENT_ID', 'Identitas kiriman tidak valid.'],
  ['INVALID_HOUSE', 'Nomor kandang CSV tidak valid.'],
  ['INVALID_TIME', 'Tanggal/jam sesi tidak valid atau melebihi waktu saat ini.'],
  ['INVALID_COUNT', 'Jumlah telur tidak valid atau melebihi batas database.'],
  ['EVENT_HASH_MISMATCH', 'Identitas kiriman tidak sesuai isi data sesi.'],
  ['MAPPING_DATE_MISMATCH', 'Nomor kandang terdaftar, tetapi tanggal sesi belum cocok dengan periode flock. Retry otomatis setiap 1 jam.'],
  ['MAPPING_AMBIGUOUS', 'Ada lebih dari satu mapping tanggal yang cocok. Admin perlu memperbaiki overlap.'],
  ['MAPPING_TARGET_INVALID', 'Relasi kandang, farm atau flock pada mapping tidak valid.'],
  ['HOUSE_UNMAPPED', 'Nomor kandang tidak dipetakan untuk perangkat ini; dilewati.'],
  ['LOCAL_SESSION_CONFLICT', 'Client menemukan jumlah berbeda pada kandang/waktu yang sama; laporan tersimpan untuk admin server.'],
]);

export async function scan(store, config) {
  let skipped = 0;
  const records = parseCsv(await stableRead(config.csvPath), config.encoding, {
    onInvalidRow: () => { skipped++; },
  });
  return { scanned: records.length, inserted: store.ingest(records), skipped };
}

export async function sendPending(store, config, credential, fetcher = fetch) {
  if (!config.enabled) return { sent: 0, disabled: true };
  validateEndpoint(config.apiUrl);
  if (!credential) throw new Error('ABI_EGG_CREDENTIAL belum diatur.');
  let sent = 0;
  let ignored = 0;
  let deferred = 0;
  let reported = 0;
  for (const row of store.deliverable()) {
    store.attempt(row.event_id);
    let readingAck = false;
    try {
      const url = new URL(config.apiUrl);
      if (row.local_conflict) {
        if (!url.pathname.endsWith('/sessions')) throw new Error('Unsupported report endpoint');
        url.pathname = url.pathname.slice(0, -'sessions'.length) + 'issues';
      }
      const response = await fetcher(url.href, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
        body: JSON.stringify({ event_id: row.event_id, source_house_number: row.source_house_number,
          recorded_at: row.recorded_at, egg_count: row.egg_count,
          ...(row.local_conflict ? { client_issue: 'LOCAL_SESSION_CONFLICT', report_only: true } : {}) }),
      });
      // Authentication, route errors and server failures must never discard queued production.
      if (!response.ok) {
        await response.body?.cancel();
        store.failed(row.event_id, `HTTP ${response.status}; belum dikonfirmasi server.`, false, row.attempt_count + 1);
        break;
      }
      readingAck = true;
      const ack = await response.json();
      if (ack.event_id !== row.event_id || !['accepted', 'duplicate', 'rejected', 'retry', 'ignored'].includes(ack.status)) {
        throw new Error('Invalid acknowledgment');
      }
      const known = rejectionMessages.has(ack.code);
      const code = known ? ack.code : 'UNKNOWN_REJECTION';
      const message = known ? `[${code}] ${rejectionMessages.get(code)}` : 'Server menolak data; kode penolakan tidak dikenali.';
      if (row.local_conflict) {
        if (ack.status !== 'rejected' || ack.issue_recorded !== true) throw new Error('Report not recorded');
        store.disposition(row.event_id, 'needs_review', code, message);
        reported++;
      } else if (ack.status === 'ignored') {
        if (ack.code !== 'HOUSE_UNMAPPED') throw new Error('Unknown ignore reason');
        store.disposition(row.event_id, 'ignored', code, message);
        ignored++;
      } else if (ack.status === 'retry' || (ack.status === 'rejected' &&
        (['MAPPING_MISSING_OR_AMBIGUOUS', 'MAPPING_DATE_MISMATCH', 'MAPPING_AMBIGUOUS', 'MAPPING_TARGET_INVALID', 'FLOCK_SOURCE_NOT_AI'].includes(ack.code) || ack.issue_recorded !== true))) {
        store.disposition(row.event_id, 'pending', code, message, 3600);
        deferred++;
      } else if (ack.status === 'rejected') {
        store.disposition(row.event_id, 'needs_review', code, message);
        reported++;
      } else { store.sent(row.event_id); sent++; }
    } catch (error) {
      // Do not persist remote response bodies or errors that might contain credentials.
      const message = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'Timeout 15 detik: server belum mengonfirmasi. Periksa log INGEST di server.'
        : readingAck ? 'Konfirmasi server bukan JSON yang valid atau event_id/status tidak cocok.'
          : 'Koneksi ke server gagal. Periksa alamat endpoint, layanan server, dan jaringan.';
      store.failed(row.event_id, message, false, row.attempt_count + 1);
      break;
    }
  }
  return { sent, ignored, deferred, reported, disabled: false };
}
