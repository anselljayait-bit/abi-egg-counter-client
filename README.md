# ABI Egg Counter Client

Client Windows tahap awal berbasis Node.js (terminal/background), bukan installer atau GUI.
Membaca CSV ReleaseB, menyimpan outbox SQLite, lalu mengirim sesi ke API ABI.
Tidak mengubah CSV atau mengakses database server langsung. Penulisan sesi/total dilakukan API.

## Menjalankan

Butuh Node.js >=22.13 (node:sqlite masih experimental pada versi Node 22 yang digunakan).

```powershell
cd "D:\Project\Abi Development Git\abi-egg-counter-client"
npm ci
npm run init
npm run scan
npm run status
```

Jika lokasi CSV salah, perbaiki tanpa menghapus SQLite/config lain:
```powershell
node src/cli.js set-csv "D:\releaseB\excel\day.csv"
```
Tanda kurung siku pada prompt menunjukkan nilai default, bukan bagian dari lokasi file.

Setup menanyakan lokasi CSV dan URL API (boleh kosong). Pengiriman default NONAKTIF.
Data disimpan di `%LOCALAPPDATA%\ABI\EggCounterSync`, di luar ReleaseB.
Gunakan akun Windows yang sama untuk setup dan menjalankan client.
Override lokasi dengan environment `ABI_EGG_HOME` sebelum menjalankan semua perintah.
Jangan ganti data directory untuk operasi biasa: di sana tersimpan histori deduplikasi.

Config `config.json` berisi csvPath, apiUrl, encoding (gb18030), intervalSeconds (300),
dan enabled (false). Aktifkan enabled hanya setelah kontrak API di bawah sudah tersedia
dan daftar kandang/flock tujuan diperiksa. Scan pertama memasukkan SEMUA data lama di CSV.

Credential tidak masuk source/config/SQLite. Atur `ABI_EGG_CREDENTIAL` pada environment
proses yang menjalankan aplikasi, tanpa memasukkannya ke version control atau command log.
Credential adalah rahasia permanen; gunakan akun Windows terbatas dan HTTPS.

Untuk server di PC yang sama, HTTP khusus loopback diperbolehkan (localhost, 127.0.0.1,
atau ::1). HTTP ke LAN/IP publik tetap ditolak. Atur endpoint tanpa mengirim antrean:
```powershell
node src/cli.js set-endpoint "http://127.0.0.1:5062/api/egg-counter-ai/sessions"
```
Perintah ini selalu menonaktifkan pengiriman dan tidak mengubah SQLite/lokasi CSV.
Setelah credential environment serta mapping tanggal/flock diverifikasi, gunakan
`node src/cli.js enable`, kemudian `npm run sync` untuk mengirim antrean pending.
`node src/cli.js disable` menonaktifkan pengiriman. Hentikan proses run sebelum mengubah
config; jalankan ulang agar konfigurasi baru terbaca. Jangan kirim data historis yang
sudah tercatat di total server tanpa rekonsiliasi terlebih dahulu.

```powershell
npm run sync    # Satu scan + pengiriman antrean (hanya jika enabled=true)
npm start       # Loop setiap 5 menit, Ctrl+C untuk berhenti dengan aman
node src/cli.js retry EVENT_ID
npm test
```

Belum mendaftarkan Windows Service/Task Scheduler. `npm start` berjalan selama proses
terminal hidup. Untuk operasi unattended berikutnya, jadwalkan dengan Task Scheduler
di akun yang sama, environment credential tersedia, dan restart on failure. Jangan
menjalankan sebagai SYSTEM dengan data directory berbeda. Hanya satu proses per data
directory diperbolehkan (named pipe Windows). Status/scan kedua ditolak selama run aktif.

## Pembacaan dan deduplikasi

- Format CSV: header, lalu `YYYYMMDD,HH:mm:ss,nomor_kandang,jumlah,`.
- Tanggal ditafsirkan WIB. GB18030 mendukung header GBK ReleaseB; UTF-8 bisa dikonfigurasi.
- Baca dua snapshot terpisah 1,5 detik; jika berubah, tunda scan. Tidak ada batas ukuran
  file dari aplikasi. Pembacaan masih memakai memori, sehingga kapasitas RAM/Node tetap berlaku.
- Baris paling akhir tanpa newline ditunda sampai lengkap. Jangan menghapus newline akhir.
- Parser CSV mendukung quoting dalam satu baris, sesuai format sesi ReleaseB; field multiline
  tidak didukung. Baris tidak valid (termasuk kutip rusak) dilewati tanpa menghalangi baris valid.
  Log scan menampilkan `scanned` (baris valid), `inserted` (event baru), dan `skipped` (baris invalid).
  Baris invalid tidak dimasukkan ke SQLite/dikirim ke server; jika diperbaiki pada CSV,
  scan berikutnya akan memprosesnya. Header dan baris kosong tidak dihitung sebagai skipped.
- File kosong/hilang tidak menghapus antrean. Antrean lama tetap bisa dikirim.
- Event ID: SHA256(JSON.stringify([recorded_at dengan +07:00, nomor kandang string normal,
  jumlah telur integer])). Format ini harus tetap sama pada semua versi client.
- Insert baru hanya untuk ID yang belum ada. SQLite menggunakan transaksi dan WAL.
- Dua sesi berbeda dengan empat nilai persis sama dianggap satu; format CSV tidak dapat
  membedakannya. Nomor kandang/timestamp yang diedit juga tidak selalu bisa dideteksi.
- Jika kandang dan waktu sama tetapi jumlah berbeda, tahan sebagai needs_review.
  Client melaporkan kedua versi yang belum terkirim melalui endpoint /issues, bukan /sessions.
  Tidak otomatis menambahkan selisih atau mengubah total yang sudah terkirim. Setelah laporan
  tersimpan, admin memeriksa egg_counter_ai_issues di server; tidak perlu review pada PC client.
  Retry konflik ditolak sampai ada rekonsiliasi (koreksi total otomatis belum diimplementasikan).
- Jangan hapus baris sent, SQLite, atau pindahkan credential ke perangkat baru sembarangan.
  Server juga harus mempertahankan deduplikasi; SQLite hilang bukan alasan menghitung ulang.
- Keadaan database bisa dilihat dengan `npm run status`: jumlah per status dan 10 event terbaru.
- Retry gangguan sementara mundur 5 menit sampai maksimal 60 menit. Maksimal 100 event/siklus.
- Tidak ada koneksi ke MySQL/ClickHouse langsung dari client.

## Status dan operasi otomatis

| Status | Perilaku |
| --- | --- |
| pending | Belum dikonfirmasi; gangguan sementara retry 5-60 menit, masalah mapping retry 1 jam. |
| sent | Diterima atau duplicate; tidak dikirim lagi. |
| ignored | Nomor CSV tidak terdaftar pada mapping perangkat; tidak dikirim lagi. |
| needs_review | Konflik/invalid permanen; dilaporkan ke server untuk admin, bukan operator client. |

`report_pending=1` berarti laporan konflik masih menunggu konfirmasi penyimpanan di server.
Koneksi laporan yang gagal akan dicoba lagi. Setelah issue_recorded=true, laporan tidak
dikirim terus-menerus dan jumlah telur tetap tidak bertambah.

Nomor yang sudah terdaftar tetapi tanggal/flock tidak cocok tetap pending. Admin cukup
memperbaiki mapping di server; pada retry berikutnya data bisa diterima tanpa mengubah
client. Jangan memperluas periode flock baru agar menerima produksi flock lama.
Nomor yang benar-benar tidak dipakai sebaiknya dibiarkan tanpa mapping. Data ignored
tidak otomatis dibuka kembali saat mapping baru dibuat; backfill memerlukan tindakan
admin yang terkontrol, bukan menghapus SQLite atau memutar ulang seluruh CSV.

`npm start` tidak berhenti karena timeout, server mati, autentikasi gagal, atau CSV hilang.
Antrean tetap tersimpan dan siklus berikutnya mencoba lagi. Perubahan credential
environment/config membutuhkan restart proses; masalah disk/SQLite tetap memerlukan
penanganan admin. Untuk restart setelah reboot gunakan Task Scheduler seperti petunjuk di atas.

## Upgrade dari versi lama

Upgrade server lebih dahulu, jalankan SQL `database/upgrade-autonomous-sync.sql` pada
project abi-egg-counter-server, lalu jalankan ulang server. Hentikan client lama dan
backup folder datanya sebelum menjalankan versi baru. SQLite dimigrasikan otomatis
dalam satu transaksi. Data sent dan event_id tidak diubah. needs_review lama yang bukan
konflik lokal kembali pending untuk divalidasi server; konflik lokal menjadi laporan saja.

## Kontrak API (abi-egg-counter-server)

URL endpoint diisi lewat konfigurasi; client tidak mengasumsikan route produksi sudah ada.
Satu POST per event, `Authorization: Bearer <credential>`, JSON:

```json
{
  "event_id": "sha256-64-karakter",
  "source_house_number": "2",
  "recorded_at": "2026-09-17T08:00:00+07:00",
  "egg_count": 500
}
```

Jawaban HTTP 2xx wajib berisi event_id yang sama dan status:

```json
{ "event_id": "sha256-64-karakter", "status": "accepted" }
```

- accepted: sesi dan total harian berhasil disimpan satu transaksi.
- duplicate: ID sudah pernah diterima; tidak menambah total; client menandai sent.
- ignored + HOUSE_UNMAPPED: nomor CSV tidak dipakai; simpan ignored.
- retry: masalah mapping/tanggal/flock/source; pending dan coba lagi setiap 1 jam.
- rejected dengan issue_recorded=true: konflik/data invalid sudah dicatat server;
  client menahan needs_review tanpa menambah total.
- Penolakan dari server lama tanpa konfirmasi issue tetap pending agar tidak bergantung
  pada review di PC. Kode penolakan mapping lama juga menjadi retry otomatis.
- HTTP non-2xx, timeout, JSON salah, atau ID tidak cocok: tetap pending, berhenti mengirim
  batch siklus tersebut. HTTP 401/403 tidak menandai seluruh antrean sebagai data rusak.
- Server harus validasi credential aktif, mapping kandang milik farm perangkat, source AI,
  dan flock yang benar untuk TANGGAL SESI. Jangan memasukkan data historis ke flock aktif
  saat ini secara otomatis jika periode ambigu.
- Unique(device_id,event_id) dan transaksi INSERT sesi + increment total WAJIB di server.
  Client sendiri tidak bisa menjamin total server bebas duplikat setelah timeout.

## Verifikasi

Tes memakai SQLite sementara dan fetch tiruan, tanpa akses server produksi.
Tes meliputi migrasi antrean lama, retry mapping, ignored, pelaporan konflik dan deduplikasi.
Belum diuji end-to-end dengan database produksi; lakukan pengujian staging sebelum aktivasi.

Referensi: https://csv.js.org/parse/options/ dan https://nodejs.org/docs/latest-v22.x/api/sqlite.html
