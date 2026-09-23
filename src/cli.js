import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from './store.js';
import { hash } from './csv.js';
import { scan, sendPending } from './sync.js';
import { validateEndpoint } from './endpoint.js';

const home = resolve(process.env.ABI_EGG_HOME || join(process.env.LOCALAPPDATA || homedir(), 'ABI', 'EggCounterSync'));
const configPath = join(home, 'config.json');
const command = process.argv[2] || 'help';
const log = (message, detail = '') => console.log(`[${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB] ${message}`, detail);

function validate(config) {
  if (!config.csvPath || typeof config.csvPath !== 'string') throw new Error('csvPath wajib diisi.');
  if (typeof config.enabled !== 'boolean') throw new Error('enabled harus true atau false.');
  if (!Number.isInteger(config.intervalSeconds) || config.intervalSeconds < 30) throw new Error('intervalSeconds minimal 30.');
  new TextDecoder(config.encoding, { fatal: true });
  if (config.apiUrl) {
    validateEndpoint(config.apiUrl);
  } else if (config.enabled) throw new Error('apiUrl wajib diisi sebelum pengiriman diaktifkan.');
  if (resolve(dirname(config.csvPath)).toLowerCase() === home.toLowerCase()) throw new Error('SQLite/config harus di luar folder CSV ReleaseB.');
  return config;
}

async function main() {
  if (!['init', 'scan', 'status', 'once', 'run', 'retry', 'set-csv', 'set-endpoint', 'enable', 'disable'].includes(command)) {
    console.log('ABI Egg Counter Sync\nnode src/cli.js init | scan | status | once | run | retry <event_id> | set-csv <path> | set-endpoint <url> | enable | disable\nCredential: environment ABI_EGG_CREDENTIAL\nData directory:', home);
    return;
  }
  await mkdir(home, { recursive: true });
  // OS releases this lock after exit/crash, so no stale lock-file cleanup is needed.
  const lock = createServer();
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\abi-egg-${hash(home).slice(0, 24)}` : join(home, 'client.sock');
  await new Promise((ok, fail) => { lock.once('error', fail); lock.listen(address, ok); });
  let store;
  try {
    if (command === 'init') {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const csvPath = (await rl.question('Lokasi CSV [D:\\releaseB\\excel\\day.csv]: ')).trim() || 'D:\\releaseB\\excel\\day.csv';
        const apiUrl = (await rl.question('URL endpoint HTTPS atau HTTP localhost (kosong jika belum tersedia): ')).trim();
        const config = validate({ csvPath: resolve(csvPath), apiUrl, encoding: 'gb18030', intervalSeconds: 300, enabled: false });
        await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        log('Setup selesai. Pengiriman nonaktif.', configPath);
      } finally { rl.close(); }
      return;
    }
    let configText;
    try { configText = await readFile(configPath, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Config belum tersedia: ${configPath}. Jalankan npm run init.`);
      throw error;
    }
    const config = validate(JSON.parse(configText));
    if (['set-endpoint', 'enable', 'disable'].includes(command)) {
      let updated = { ...config };
      if (command === 'set-endpoint') {
        if (!process.argv[3]) throw new Error('Gunakan: node src/cli.js set-endpoint <url>');
        updated = { ...config, apiUrl: validateEndpoint(process.argv[3]), enabled: false };
      } else {
        if (command === 'enable' && !process.env.ABI_EGG_CREDENTIAL) throw new Error('Atur ABI_EGG_CREDENTIAL dahulu.');
        updated.enabled = command === 'enable';
      }
      validate(updated);
      await writeFile(configPath, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
      log(updated.enabled ? 'Pengiriman diaktifkan. npm run sync akan mengirim antrean pending; pastikan mapping tanggal/flock benar.' :
        'Konfigurasi diperbarui. Pengiriman nonaktif; tidak ada data yang dikirim.');
      return;
    }
    if (command === 'set-csv') {
      if (!process.argv[3]) throw new Error('Gunakan: node src/cli.js set-csv "D:\\releaseB\\excel\\day.csv"');
      const csvPath = resolve(process.argv[3]);
      const info = await stat(csvPath);
      if (!info.isFile()) throw new Error('Lokasi CSV harus menunjuk file.');
      const updated = validate({ ...config, csvPath });
      await writeFile(configPath, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
      log('Lokasi CSV diperbarui; antrean tidak diubah.', csvPath);
      return;
    }
    store = new Store(join(home, 'egg-counter-sync.db'));
    if (command === 'status') { console.log(JSON.stringify(store.status(), null, 2)); return; }
    if (command === 'retry') { store.retry(process.argv[3] || ''); log('Event dikembalikan ke pending.'); return; }
    if (command === 'scan') { log('Scan selesai', await scan(store, config)); return; }
    let stopping = false;
    const abort = new AbortController();
    const stop = () => { stopping = true; abort.abort(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      do {
        try { log('Scan selesai', await scan(store, config)); }
        catch (error) { log('Scan ditunda', error.code === 'ENOENT' ? 'CSV tidak ditemukan.' : error.message); }
        if (!stopping) {
          try { log('Sinkronisasi', await sendPending(store, config, process.env.ABI_EGG_CREDENTIAL)); }
          catch (error) {
            if (command !== 'run') throw error;
            log('Sinkronisasi ditunda', 'Periksa konfigurasi endpoint dan ABI_EGG_CREDENTIAL. Client akan mencoba lagi pada siklus berikutnya.');
          }
        }
        if (command !== 'run' || stopping) break;
        await sleep(config.intervalSeconds * 1000, undefined, { signal: abort.signal }).catch(() => {});
      } while (!stopping);
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } finally { store?.close(); lock.close(); }
}

main().catch((error) => {
  console.error(error.code === 'EADDRINUSE' ? 'Client lain sedang memakai data directory ini.' :
    error.code === 'EEXIST' ? 'Config sudah ada; init tidak menimpa konfigurasi.' :
      error.code === 'ENOENT' ? `File atau folder tidak ditemukan: ${error.path || '(lokasi tidak diketahui)'}. Periksa lokasi CSV pada ${configPath}.` : error.message);
  process.exitCode = 1;
});
