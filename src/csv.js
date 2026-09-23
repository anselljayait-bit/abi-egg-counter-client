import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse } from 'csv-parse/sync';

export const hash = (value) => createHash('sha256').update(value).digest('hex');

export function normalizeRow(fields) {
  if (fields.length < 4 || fields.slice(4).some((value) => value.trim() !== '')) {
    throw new Error('Jumlah kolom CSV tidak sesuai (tanggal, jam, kandang, jumlah).');
  }
  const [date, time, house, eggs] = fields.map((value) => value.trim());
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(date);
  if (!match || !/^\d{2}:\d{2}:\d{2}$/.test(time)) throw new Error('Format tanggal/jam tidak valid.');
  const isoDate = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${isoDate}T${time}Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== `${isoDate}T${time}`) {
    throw new Error('Tanggal/jam tidak valid.');
  }
  if (!/^\d+$/.test(house) || !/^\d+$/.test(eggs)) throw new Error('Kandang/jumlah harus bilangan bulat nonnegatif.');
  const number = Number(house);
  const count = Number(eggs);
  if (!Number.isSafeInteger(number) || !Number.isSafeInteger(count)) throw new Error('Angka melebihi batas aman.');
  const record = { source_house_number: String(number), recorded_at: `${isoDate}T${time}+07:00`, egg_count: count };
  return { event_id: hash(JSON.stringify([record.recorded_at, record.source_house_number, count])), ...record };
}

export function parseCsv(buffer, encoding = 'gb18030', { onInvalidRow = () => {} } = {}) {
  const text = new TextDecoder(encoding).decode(buffer);
  const completed = text.slice(0, Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1);
  const records = [];
  let hasHeader = false;
  // ReleaseB uses one physical line per session. Isolate broken quoting and only read completed lines.
  for (const match of completed.matchAll(/([^\r\n]*)(?:\r\n|\r|\n)/g)) {
    const line = match[1];
    if (!line.trim()) continue;
    let row;
    try {
      [row] = parse(line, { bom: true, trim: true, relax_column_count: true });
    } catch {
      if (hasHeader) onInvalidRow();
      else hasHeader = true;
      continue;
    }
    if (!hasHeader) {
      // Refuse headerless input instead of silently dropping its first production row.
      if (/^\d{4}-?\d{2}-?\d{2}$/.test(row[0]?.trim())) throw new Error('Header CSV tidak ditemukan.');
      hasHeader = true;
      continue;
    }
    try { records.push(normalizeRow(row)); }
    catch { onInvalidRow(); }
  }
  return records;
}

export async function stableRead(file, { settleMs = 1500 } = {}) {
  const read = async () => {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('CSV bukan file biasa.');
    return readFile(file);
  };
  const first = await read();
  await sleep(settleMs);
  const second = await read();
  if (!first.equals(second)) throw new Error('CSV sedang berubah; pembacaan ditunda.');
  return second;
}
