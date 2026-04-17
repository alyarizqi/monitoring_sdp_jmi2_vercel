/**
 * ESP32 PowerLogic PM5350 — Vercel + Supabase Server
 *
 * Arsitektur:
 *   ESP32  →  POST /data  →  server  →  Supabase (simpan)
 *   Browser polling /api/latest    ←  server (ambil data terakhir)
 *   Browser polling /api/history   ←  server  →  Supabase (7 hari)
 *   Browser polling /api/alarms    ←  server  →  Supabase (alarm log)
 *   Browser POST /api/test-alert   →  server  →  Telegram
 *   Server cek threshold tiap data masuk → Telegram jika violation
 *
 * Environment variables yang WAJIB diset di Vercel:
 *   SUPABASE_URL       = https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY  = eyJxxx...
 *   TELEGRAM_BOT_TOKEN = 123456:ABC-xxx
 *   TELEGRAM_CHAT_IDS  = 111111,222222   (pisah koma, bisa 1 atau lebih)
 */

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const PORT = process.env.PORT || 3000;

// ─── ENV ──────────────────────────────────────────────────────
const SUPABASE_URL      = process.env.SUPABASE_URL      || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const TG_TOKEN          = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_IDS       = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// ─── THRESHOLD ────────────────────────────────────────────────
const VOLT_LN_OVER  = 231;   // V  L-N over voltage
const VOLT_LN_UNDER = 209;   // V  L-N under voltage
const VOLT_LL_OVER  = 400;   // V  L-L over voltage
const VOLT_LL_UNDER = 360;   // V  L-L under voltage
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 menit

// ─── RUNTIME STATE ───────────────────────────────────────────
let latestData = null;
let lastSeen   = null;

/**
 * Cooldown per fase. Key contoh: 'ovln_R', 'uvln_S', 'ovll_RS', 'uvll_ST'
 * Value: timestamp kapan terakhir alert dikirim
 */
const alertCooldown = {};

// ─── SUPABASE HELPER ──────────────────────────────────────────
/**
 * Panggil Supabase REST API langsung pakai http.request (tanpa SDK)
 * supaya bisa jalan di Vercel tanpa masalah module.
 * Tapi kita pakai fetch bawaan Node 18+ yang lebih ringkas.
 */
async function supabaseFetch(path, options = {}) {
  const url = SUPABASE_URL + '/rest/v1' + path;
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
    'Prefer': options.prefer || 'return=minimal',
    ...options.headers
  };
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${res.status}: ${err}`);
  }
  // HEAD / DELETE tidak return body
  if (options.method === 'DELETE' || options.noBody) return null;
  return res.json();
}

// ─── SIMPAN DATA KE SUPABASE ─────────────────────────────────
async function saveToSupabase(data) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  // Map field dari ESP32 JSON ke kolom Supabase
  // Pastikan nama kolom di tabel `pm_readings` sudah sesuai
  const row = {
    volt_r:   data.voltR,   volt_s:   data.voltS,   volt_t:   data.voltT,
    volt_rs:  data.voltRS,  volt_st:  data.voltST,  volt_tr:  data.voltTR,
    amp_r:    data.ampR,    amp_s:    data.ampS,     amp_t:    data.ampT,
    amp_3p:   data.amp3P,
    power_r:  data.powerR,  power_s:  data.powerS,  power_t:  data.powerT,
    power_3p: data.power3P,
    kwh:      data.kwh,
    freq:     data.freq,
    thd_volt_r:  data.thdVoltR,  thd_volt_s:  data.thdVoltS,  thd_volt_t:  data.thdVoltT,
    thd_volt_rs: data.thdVoltRS, thd_volt_st: data.thdVoltST, thd_volt_tr: data.thdVoltTR,
    thd_amp_r:   data.thdAmpR,   thd_amp_s:   data.thdAmpS,   thd_amp_t:   data.thdAmpT,
    // Fault config values
    ov_thd_val_r: data.ovThdValR, ov_thd_val_s: data.ovThdValS, ov_thd_val_t: data.ovThdValT,
    phase_loss_val_r: data.phaseLossValR, phase_loss_val_s: data.phaseLossValS, phase_loss_val_t: data.phaseLossValT,
    ov_volt_ll_val_rs: data.ovVoltLLValRS, ov_volt_ll_val_st: data.ovVoltLLValST, ov_volt_ll_val_tr: data.ovVoltLLValTR,
    ov_volt_ll_pickup: data.ovVoltLLPickup, ov_volt_ll_dropout: data.ovVoltLLDropout,
    uv_volt_ll_val_rs: data.uvVoltLLValRS, uv_volt_ll_val_st: data.uvVoltLLValST, uv_volt_ll_val_tr: data.uvVoltLLValTR,
    uv_volt_ll_pickup: data.uvVoltLLPickup, uv_volt_ll_dropout: data.uvVoltLLDropout,
    ov_volt_ln_val_r: data.ovVoltLNValR, ov_volt_ln_val_s: data.ovVoltLNValS, ov_volt_ln_val_t: data.ovVoltLNValT,
    ov_volt_ln_pickup: data.ovVoltLNPickup, ov_volt_ln_dropout: data.ovVoltLNDropout,
    uv_volt_ln_val_r: data.uvVoltLNValR, uv_volt_ln_val_s: data.uvVoltLNValS, uv_volt_ln_val_t: data.uvVoltLNValT,
    uv_volt_ln_pickup: data.uvVoltLNPickup, uv_volt_ln_dropout: data.uvVoltLNDropout,
    // ESP info
    uptime: data.uptime, heap: data.heap, rssi: data.rssi, temp: data.temp, ip: data.ip,
  };
  try {
    await supabaseFetch('/pm_readings', { method: 'POST', body: row });
  } catch (e) {
    console.error('[Supabase] Gagal simpan data:', e.message);
  }
}

// ─── AUTO-DELETE DATA > 7 HARI ───────────────────────────────
async function deleteOldData() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    await supabaseFetch(`/pm_readings?created_at=lt.${cutoff}`, {
      method: 'DELETE', prefer: 'return=minimal', noBody: true
    });
    console.log('[Supabase] Old data deleted, cutoff:', cutoff);
  } catch (e) {
    console.error('[Supabase] Gagal hapus data lama:', e.message);
  }
}

// ─── SIMPAN ALARM KE SUPABASE ────────────────────────────────
async function saveAlarmToSupabase(tipe, phase, nilai, threshold, telegramSent) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  try {
    await supabaseFetch('/pm_alarms', {
      method: 'POST',
      body: { tipe, phase, nilai, threshold, telegram_sent: telegramSent }
    });
  } catch (e) {
    console.error('[Supabase] Gagal simpan alarm:', e.message);
  }
}

async function sendTelegramTo(chatId, message) {
  if (!TG_TOKEN) return false;
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
  });
  return res.ok;
}

// ─── TELEGRAM ─────────────────────────────────────────────────
async function sendTelegram(message) {
  if (!TG_TOKEN || TG_CHAT_IDS.length === 0) {
    console.warn('[Telegram] Token/ChatID belum diset');
    return false;
  }
  const promises = TG_CHAT_IDS.map(chatId =>
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    }).then(r => {
      if (!r.ok) console.error(`[Telegram] Gagal ke chat ${chatId}: ${r.status}`);
      return r.ok;
    }).catch(e => {
      console.error(`[Telegram] Error ke chat ${chatId}:`, e.message);
      return false;
    })
  );
  const results = await Promise.all(promises);
  return results.some(Boolean);
}

// ─── CEK THRESHOLD & KIRIM ALERT ─────────────────────────────
async function checkThresholds(data) {
  const now = Date.now();

  const checks = [
    // [key, kondisi, tipe, phase, nilai, threshold]
    ['ovln_R', data.voltR > VOLT_LN_OVER,  'Over Voltage L-N',   'R',  data.voltR,  VOLT_LN_OVER],
    ['ovln_S', data.voltS > VOLT_LN_OVER,  'Over Voltage L-N',   'S',  data.voltS,  VOLT_LN_OVER],
    ['ovln_T', data.voltT > VOLT_LN_OVER,  'Over Voltage L-N',   'T',  data.voltT,  VOLT_LN_OVER],
    ['uvln_R', data.voltR < VOLT_LN_UNDER && data.voltR > 0, 'Under Voltage L-N', 'R', data.voltR, VOLT_LN_UNDER],
    ['uvln_S', data.voltS < VOLT_LN_UNDER && data.voltS > 0, 'Under Voltage L-N', 'S', data.voltS, VOLT_LN_UNDER],
    ['uvln_T', data.voltT < VOLT_LN_UNDER && data.voltT > 0, 'Under Voltage L-N', 'T', data.voltT, VOLT_LN_UNDER],
    ['ovll_RS', data.voltRS > VOLT_LL_OVER, 'Over Voltage L-L',  'RS', data.voltRS, VOLT_LL_OVER],
    ['ovll_ST', data.voltST > VOLT_LL_OVER, 'Over Voltage L-L',  'ST', data.voltST, VOLT_LL_OVER],
    ['ovll_TR', data.voltTR > VOLT_LL_OVER, 'Over Voltage L-L',  'TR', data.voltTR, VOLT_LL_OVER],
    ['uvll_RS', data.voltRS < VOLT_LL_UNDER && data.voltRS > 0, 'Under Voltage L-L', 'RS', data.voltRS, VOLT_LL_UNDER],
    ['uvll_ST', data.voltST < VOLT_LL_UNDER && data.voltST > 0, 'Under Voltage L-L', 'ST', data.voltST, VOLT_LL_UNDER],
    ['uvll_TR', data.voltTR < VOLT_LL_UNDER && data.voltTR > 0, 'Under Voltage L-L', 'TR', data.voltTR, VOLT_LL_UNDER],
  ];

  for (const [key, kondisi, tipe, phase, nilai, threshold] of checks) {
    if (!kondisi) continue;
    const lastAlert = alertCooldown[key] || 0;
    if (now - lastAlert < ALERT_COOLDOWN_MS) continue; // masih cooldown

    alertCooldown[key] = now;

    const isOver = tipe.includes('Over');
    const emoji  = isOver ? '⚡' : '⬇';
    const ts     = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

    const msg =
      `${emoji} <b>[ALERT] ${tipe}</b>\n` +
      `📍 Fasa: <b>${phase}</b>\n` +
      `📊 Nilai: <b>${Number(nilai).toFixed(2)} V</b>\n` +
      `🔴 Threshold: ${threshold} V\n` +
      `🕐 Waktu: ${ts} WIB\n` +
      `📟 Device: PM5350 · Modbus RTU`;

    const sent = await sendTelegram(msg);
    await saveAlarmToSupabase(tipe, phase, nilai, threshold, sent);
    console.log(`[Alert] ${tipe} fasa ${phase} = ${nilai.toFixed(2)}V, Telegram: ${sent}`);
  }
}

// ─── CORS HEADERS ─────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ─── JSON RESPONSE HELPER ─────────────────────────────────────
function jsonRes(res, status, data) {
  setCORS(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ─── HTTP SERVER ──────────────────────────────────────────────
const httpServer = http.createServer(async (req, res) => {

  setCORS(res);

  // Preflight OPTIONS
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── POST /data  (dari ESP32) ──────────────────────────────
  if (req.method === 'POST' && req.url === '/data') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        latestData = data;
        lastSeen   = new Date().toISOString();

        // Simpan ke Supabase (non-blocking)
        saveToSupabase(data).catch(e => console.error('[saveToSupabase]', e.message));

        // Cek threshold → Telegram (non-blocking)
        checkThresholds(data).catch(e => console.error('[checkThresholds]', e.message));

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
      } catch (e) {
        console.error('[POST /data] Bad JSON:', e.message);
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad JSON');
      }
    });
    return;
  }

  // ── GET /api/latest  (dashboard polling) ─────────────────
  if (req.method === 'GET' && req.url === '/api/latest') {
    if (!latestData) {
      jsonRes(res, 404, { error: 'No data yet' });
      return;
    }
    jsonRes(res, 200, { ...latestData, lastSeen });
    return;
  }

  // ── GET /api/history?days=7  (grafik historis) ───────────
  if (req.method === 'GET' && req.url.startsWith('/api/history')) {
    const params  = new URL(req.url, 'http://localhost');
    const days    = Math.min(30, Math.max(1, parseInt(params.get('days') || '7', 10)));
    const cutoff  = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    if (!SUPABASE_URL) {
      jsonRes(res, 503, { error: 'Supabase not configured' });
      return;
    }

    try {
      const rows = await supabaseFetch(
        `/pm_readings?created_at=gte.${cutoff}&order=created_at.asc&select=created_at,volt_r,volt_s,volt_t,volt_rs,volt_st,volt_tr,amp_r,amp_s,amp_t,power_3p,kwh`,
        { prefer: 'return=representation', headers: { 'Range-Unit': 'items', 'Range': '0-60479' } }
      );
      jsonRes(res, 200, rows);
    } catch (e) {
      console.error('[GET /api/history]', e.message);
      jsonRes(res, 500, { error: e.message });
    }
    return;
  }

  // ── GET /api/alarms?days=7  (riwayat alarm) ──────────────
  if (req.method === 'GET' && req.url.startsWith('/api/alarms')) {
    const params  = new URL(req.url, 'http://localhost');
    const days    = Math.min(30, Math.max(1, parseInt(params.get('days') || '7', 10)));
    const cutoff  = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    if (!SUPABASE_URL) {
      jsonRes(res, 503, { error: 'Supabase not configured' });
      return;
    }

    try {
      const rows = await supabaseFetch(
        `/pm_alarms?created_at=gte.${cutoff}&order=created_at.desc&limit=200`
      );
      jsonRes(res, 200, rows);
    } catch (e) {
      console.error('[GET /api/alarms]', e.message);
      jsonRes(res, 500, { error: e.message });
    }
    return;
  }

  // ── POST /api/test-alert  (tombol test di dashboard) ─────
  if (req.method === 'POST' && req.url === '/api/test-alert') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { type, phase, value, threshold } = JSON.parse(body);
        const label = type === 'over' ? 'Over Voltage L-N' : 'Under Voltage L-N';
        const emoji = type === 'over' ? '⚡' : '⬇';
        const ts    = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

        const msg =
          `${emoji} <b>[TEST] ${label}</b>\n` +
          `📍 Fasa: <b>${phase || 'R'}</b>\n` +
          `📊 Nilai: <b>${Number(value || 0).toFixed(2)} V</b>\n` +
          `🔴 Threshold: ${threshold || '--'} V\n` +
          `🕐 Waktu: ${ts} WIB\n` +
          `🧪 <i>Ini adalah alert uji coba dari dashboard</i>`;

        const sent = await sendTelegram(msg);
        if (sent) {
          await saveAlarmToSupabase('[TEST] ' + label, phase || 'R', value, threshold, true);
          jsonRes(res, 200, { ok: true, message: 'Test alert terkirim ke Telegram' });
        } else {
          jsonRes(res, 500, { ok: false, error: 'Telegram tidak terkirim — cek TOKEN/CHAT_ID di env' });
        }
      } catch (e) {
        jsonRes(res, 400, { ok: false, error: e.message });
      }
    });
    return;
  }

  // ── POST /api/telegram  (terima command dari Telegram) ────
if (req.method === 'POST' && req.url === '/api/telegram') {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const update = JSON.parse(body);
      const msg = update.message;
      if (!msg || !msg.text) { res.writeHead(200); res.end('OK'); return; }

      const chatId = msg.chat.id.toString();
      const text   = msg.text.trim().split(' ')[0]; // ambil command saja, ignore parameter

      if (text === '/start') {
        await sendTelegramTo(chatId,
          'SISTEM MONITORING SDP JMI2\n\n' +
          'Command:\n' +
          '/data - Data tegangan & arus\n' +
          '/alarm - Konfigurasi alarm\n' +
          '/status - Status sistem\n' +
          '/help - Bantuan'
        );

      } else if (text === '/data') {
        if (!latestData) {
          await sendTelegramTo(chatId, '⚠️ Belum ada data dari ESP32.');
        } else {
          const d  = latestData;
          const ts = lastSeen
            ? new Date(lastSeen).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
            : '--';
          const reply =
            'DATA MONITORING SDP JMI2\n\n' +
            'Waktu: ' + ts + '\n\n' +
            'PHASE R:\n' +
            '  Tegangan: ' + Number(d.voltR  ||0).toFixed(2) + ' V\n' +
            '  Arus    : ' + Number(d.ampR   ||0).toFixed(2) + ' A\n' +
            '  Daya    : ' + Number(d.powerR ||0).toFixed(2) + ' kW\n\n' +
            'PHASE S:\n' +
            '  Tegangan: ' + Number(d.voltS  ||0).toFixed(2) + ' V\n' +
            '  Arus    : ' + Number(d.ampS   ||0).toFixed(2) + ' A\n' +
            '  Daya    : ' + Number(d.powerS ||0).toFixed(2) + ' kW\n\n' +
            'PHASE T:\n' +
            '  Tegangan: ' + Number(d.voltT  ||0).toFixed(2) + ' V\n' +
            '  Arus    : ' + Number(d.ampT   ||0).toFixed(2) + ' A\n' +
            '  Daya    : ' + Number(d.powerT ||0).toFixed(2) + ' kW\n\n' +
            '3 PHASE:\n' +
            '  V(RS): ' + Number(d.voltRS  ||0).toFixed(2) + ' V\n' +
            '  V(ST): ' + Number(d.voltST  ||0).toFixed(2) + ' V\n' +
            '  V(TR): ' + Number(d.voltTR  ||0).toFixed(2) + ' V\n' +
            '  Arus : ' + Number(d.amp3P   ||0).toFixed(2) + ' A\n' +
            '  Daya : ' + Number(d.power3P ||0).toFixed(2) + ' kW\n\n' +
            'Energi Total: ' + Number(d.kwh ||0).toFixed(2) + ' kWh\n\n' +
            'THD Tegangan L-N:\n' +
            '  R: ' + Number(d.thdVoltR||0).toFixed(2) + '%' +
            '  S: ' + Number(d.thdVoltS||0).toFixed(2) + '%' +
            '  T: ' + Number(d.thdVoltT||0).toFixed(2) + '%\n\n' +
            'THD Tegangan L-L:\n' +
            '  RS: ' + Number(d.thdVoltRS||0).toFixed(2) + '%' +
            '  ST: ' + Number(d.thdVoltST||0).toFixed(2) + '%' +
            '  TR: ' + Number(d.thdVoltTR||0).toFixed(2) + '%\n\n' +
            'THD Arus:\n' +
            '  R: ' + Number(d.thdAmpR||0).toFixed(2) + '%' +
            '  S: ' + Number(d.thdAmpS||0).toFixed(2) + '%' +
            '  T: ' + Number(d.thdAmpT||0).toFixed(2) + '%\n\n' +
            'WiFi: ' + (d.rssi||'--') + ' dBm | Heap: ' + (d.heap||'--') + ' KB';
          await sendTelegramTo(chatId, reply);
        }

      } else if (text === '/alarm') {
        if (!latestData) {
          await sendTelegramTo(chatId, '⚠️ Belum ada data dari ESP32.');
        } else {
          const d  = latestData;
          const ts = lastSeen
            ? new Date(lastSeen).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
            : '--';
          const alarmMsg =
            'ALARM CONFIG PM5350\n\n' +
            'Waktu: ' + ts + '\n\n' +
            'OV THD:\n' +
            '  Val R: '           + Number(d.ovThdValR         ||0).toFixed(2) + ' %\n' +
            '  Val S: '           + Number(d.ovThdValS         ||0).toFixed(2) + ' %\n' +
            '  Val T: '           + Number(d.ovThdValT         ||0).toFixed(2) + ' %\n' +
            '  Pickup: '          + Number(d.ovThdPickup       ||0).toFixed(2) + ' %\n' +
            '  Pickup Delay: '    + Number(d.ovThdPickupDelay  ||0).toFixed(2) + ' s\n' +
            '  Dropout: '         + Number(d.ovThdDropout      ||0).toFixed(2) + ' %\n' +
            '  Dropout Delay: '   + Number(d.ovThdDropoutDelay ||0).toFixed(2) + ' s\n\n' +
            'PHASE LOSS:\n' +
            '  Val R: '           + Number(d.phaseLossValR         ||0).toFixed(2) + ' V\n' +
            '  Val S: '           + Number(d.phaseLossValS         ||0).toFixed(2) + ' V\n' +
            '  Val T: '           + Number(d.phaseLossValT         ||0).toFixed(2) + ' V\n' +
            '  Pickup: '          + Number(d.phaseLossPickup       ||0).toFixed(2) + ' V\n' +
            '  Pickup Delay: '    + Number(d.phaseLossPickupDelay  ||0).toFixed(2) + ' s\n' +
            '  Dropout: '         + Number(d.phaseLossDropout      ||0).toFixed(2) + ' V\n' +
            '  Dropout Delay: '   + Number(d.phaseLossDropoutDelay ||0).toFixed(2) + ' s\n\n' +
            'OV VOLT L-L:\n' +
            '  Val RS: '  + Number(d.ovVoltLLValRS  ||0).toFixed(2) + ' V\n' +
            '  Val ST: '  + Number(d.ovVoltLLValST  ||0).toFixed(2) + ' V\n' +
            '  Val TR: '  + Number(d.ovVoltLLValTR  ||0).toFixed(2) + ' V\n' +
            '  Pickup: '  + Number(d.ovVoltLLPickup ||0).toFixed(2) + ' V\n' +
            '  Dropout: ' + Number(d.ovVoltLLDropout||0).toFixed(2) + ' V\n\n' +
            'UV VOLT L-L:\n' +
            '  Val RS: '  + Number(d.uvVoltLLValRS  ||0).toFixed(2) + ' V\n' +
            '  Val ST: '  + Number(d.uvVoltLLValST  ||0).toFixed(2) + ' V\n' +
            '  Val TR: '  + Number(d.uvVoltLLValTR  ||0).toFixed(2) + ' V\n' +
            '  Pickup: '  + Number(d.uvVoltLLPickup ||0).toFixed(2) + ' V\n' +
            '  Dropout: ' + Number(d.uvVoltLLDropout||0).toFixed(2) + ' V\n\n' +
            'OV VOLT L-N:\n' +
            '  Val R: '   + Number(d.ovVoltLNValR  ||0).toFixed(2) + ' V\n' +
            '  Val S: '   + Number(d.ovVoltLNValS  ||0).toFixed(2) + ' V\n' +
            '  Val T: '   + Number(d.ovVoltLNValT  ||0).toFixed(2) + ' V\n' +
            '  Pickup: '  + Number(d.ovVoltLNPickup ||0).toFixed(2) + ' V\n' +
            '  Dropout: ' + Number(d.ovVoltLNDropout||0).toFixed(2) + ' V\n\n' +
            'UV VOLT L-N:\n' +
            '  Val R: '   + Number(d.uvVoltLNValR  ||0).toFixed(2) + ' V\n' +
            '  Val S: '   + Number(d.uvVoltLNValS  ||0).toFixed(2) + ' V\n' +
            '  Val T: '   + Number(d.uvVoltLNValT  ||0).toFixed(2) + ' V\n' +
            '  Pickup: '  + Number(d.uvVoltLNPickup ||0).toFixed(2) + ' V\n' +
            '  Dropout: ' + Number(d.uvVoltLNDropout||0).toFixed(2) + ' V';

          // Split jika > 4000 karakter (sama seperti logika ESP32)
          if (alarmMsg.length > 4000) {
            await sendTelegramTo(chatId, alarmMsg.substring(0, 4000));
            await new Promise(r => setTimeout(r, 500));
            await sendTelegramTo(chatId, alarmMsg.substring(4000));
          } else {
            await sendTelegramTo(chatId, alarmMsg);
          }
        }

      } else if (text === '/status') {
        const online = lastSeen && (Date.now() - new Date(lastSeen).getTime()) < 30000;
        const ts     = lastSeen
          ? new Date(lastSeen).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
          : 'Belum ada data';
        const d      = latestData || {};
        const uptimeSec = d.uptime || 0;
        const jam    = Math.floor(uptimeSec / 3600);
        const menit  = Math.floor((uptimeSec % 3600) / 60);
        const reply  =
          'STATUS SISTEM\n\n' +
          'ESP32: '    + (online ? 'ONLINE ✅' : 'OFFLINE ❌') + '\n' +
          'Last seen: '+ ts + '\n' +
          'WiFi: '     + (d.rssi  || '--') + ' dBm\n' +
          'IP: '       + (d.ip    || '--') + '\n' +
          'Uptime: '   + jam + 'j ' + menit + 'm\n' +
          'RAM: '      + (d.heap  || '--') + ' KB\n' +
          'Temp: '     + (d.temp  != null ? Number(d.temp).toFixed(1) : '--') + ' C\n' +
          'Vercel: OK ✅\n' +
          'Supabase: ' + (SUPABASE_URL ? 'OK ✅' : 'Belum diset ❌') + '\n' +
          'Telegram: ' + (TG_TOKEN    ? 'OK ✅' : 'Belum diset ❌');
        await sendTelegramTo(chatId, reply);

      } else if (text === '/help') {
        await sendTelegramTo(chatId,
          'BANTUAN MONITORING SDP JMI2\n\n' +
          '/data   - Tegangan, arus, daya, THD\n' +
          '/alarm  - Threshold & konfigurasi alarm\n' +
          '/status - WiFi, Modbus, Vercel, Supabase\n' +
          '/start  - Menu utama'
        );
      }

      res.writeHead(200); res.end('OK');
    } catch(e) {
      console.error('[Telegram webhook]', e.message);
      res.writeHead(200); res.end('OK'); // selalu 200 ke Telegram
    }
  });
  return;
}
  
  // ── GET /status  (health check) ──────────────────────────
  if (req.method === 'GET' && req.url === '/status') {
    jsonRes(res, 200, {
      online:   latestData !== null,
      lastSeen,
      supabase: !!SUPABASE_URL,
      telegram: !!TG_TOKEN && TG_CHAT_IDS.length > 0,
      chatIds:  TG_CHAT_IDS.length,
    });
    return;
  }

  // ── GET /  (serve dashboard HTML) ────────────────────────
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Dashboard not found. Taruh file HTML di folder public/index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ─── SCHEDULE: Hapus data lama setiap 6 jam ───────────────────
setInterval(deleteOldData, 6 * 60 * 60 * 1000);
// Juga jalankan sekali saat server start
deleteOldData();

// ─── START ────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   ESP32 PM5350 Dashboard Server v2.0             ║
║   Port        : ${String(PORT).padEnd(32)}║
║   Supabase    : ${(SUPABASE_URL ? '✓ OK' : '✗ BELUM DISET').padEnd(32)}║
║   Telegram    : ${(TG_TOKEN ? `✓ OK (${TG_CHAT_IDS.length} chat ID)` : '✗ BELUM DISET').padEnd(32)}║
╠══════════════════════════════════════════════════╣
║   Endpoints:                                     ║
║   POST /data          ← dari ESP32               ║
║   GET  /api/latest    ← dashboard polling        ║
║   GET  /api/history   ← data historis 7 hari     ║
║   GET  /api/alarms    ← riwayat alarm            ║
║   POST /api/test-alert← test Telegram            ║
║   GET  /status        ← health check             ║
║   GET  /              ← dashboard HTML           ║
╚══════════════════════════════════════════════════╝
`);
});

