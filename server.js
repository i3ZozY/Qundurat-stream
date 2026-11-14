/* خدمة بث مقاطع تيليجرام ويوتيوب لموقع القندرات
 * GET /v/<channel>/<messageId>   ← يبث الفيديو من تيليجرام مع دعم Range
 * GET /f/<channel>/<messageId>   ← تحميل مباشر لملف (PDF وغيره) من رسالة في تيليجرام
 * GET /fid/<file_id>             ← تحميل مباشر عبر File ID من بوت
 * (يوتيوب لا يمر من هنا: يُشغَّل في الموقع عبر iframe رسمي مخفي)
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const bigInt = require('big-integer');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const API_ID = parseInt(process.env.TG_API_ID, 10);
const API_HASH = process.env.TG_API_HASH;
const SESSION = process.env.TG_SESSION || '';
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ALLOWED = (process.env.ALLOWED_CHANNELS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);

if (!API_ID || !API_HASH || !SESSION) {
  console.error('ناقص: TG_API_ID و TG_API_HASH و TG_SESSION (شغّل gen-session.js لإنشاء الجلسة)');
  process.exit(1);
}
if (!ALLOWED.length) console.warn('تنبيه: ALLOWED_CHANNELS غير محدد، أي قناة عامة يمكن بثها عبر خدمتك. الأفضل تحديد القنوات.');

const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, { connectionRetries: 10 });
const CH = 512 * 1024;
const entities = new Map();
const infos = new Map();
let dialogsLoaded = false;

async function getEntity(channel) {
  if (entities.has(channel)) return entities.get(channel);
  let ent;
  if (/^c\d+$/.test(channel)) {
    if (!dialogsLoaded) { await client.getDialogs({ limit: 500 }); dialogsLoaded = true; }
    ent = await client.getEntity(new Api.PeerChannel({ channelId: bigInt(channel.slice(1)) }));
  } else {
    ent = await client.getEntity(channel);
  }
  entities.set(channel, ent);
  return ent;
}

async function getInfo(channel, msgId, force) {
  const key = channel + '/' + msgId;
  const hit = infos.get(key);
  if (hit && !force && hit.exp > Date.now()) return hit;
  const ent = await getEntity(channel);
  const res = await client.getMessages(ent, { ids: [msgId] });
  const m = res && res[0];
  if (!m || !m.media || !m.media.document) return null;
  const doc = m.media.document;
  const mime = doc.mimeType || '';
  const fn = (doc.attributes || []).find(a => a instanceof Api.DocumentAttributeFilename);
  const info = {
    doc,
    size: Number(doc.size.toString()),
    mime,
    name: fn ? fn.fileName : '',
    isVideo: mime.startsWith('video/') || (doc.attributes || []).some(a => a instanceof Api.DocumentAttributeVideo),
    vmime: /matroska|x-msvideo|quicktime|mpeg$/.test(mime) || !mime.startsWith('video/') ? 'video/mp4' : mime,
    exp: Date.now() + 30 * 60 * 1000
  };
  infos.set(key, info);
  return info;
}

function waitDrainOrClose(res) {
  return new Promise(resolve => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.once('drain', done); res.once('close', done);
  });
}

async function pipeRange(info, start, end, res) {
  let closed = false;
  res.on('close', () => { closed = true; });
  const aligned = start - (start % CH);
  let skip = start - aligned;
  let remain = end - start + 1;
  const chunks = Math.ceil((skip + remain) / CH);
  const loc = new Api.InputDocumentFileLocation({
    id: info.doc.id, accessHash: info.doc.accessHash, fileReference: info.doc.fileReference, thumbSize: ''
  });
  const it = client.iterDownload({
    file: loc, dcId: info.doc.dcId, offset: bigInt(aligned), limit: chunks,
    requestSize: CH, fileSize: bigInt(info.size)
  });
  for await (const chunk of it) {
    if (closed) break;
    let buf = Buffer.from(chunk);
    if (skip) { buf = buf.subarray(skip); skip = 0; }
    if (buf.length > remain) buf = buf.subarray(0, remain);
    remain -= buf.length;
    if (!res.write(buf)) await waitDrainOrClose(res);
    if (remain <= 0) break;
  }
  if (!closed) res.end();
}

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  const origin = (req.headers.origin || '').replace(/\/$/, '');
  res.setHeader('Access-Control-Allow-Origin', ORIGINS.length ? (ORIGINS.includes(origin) ? origin : ORIGINS[0]) : '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.send('ok'));

function guard(req, res, channel, msg) {
  if (!/^(c\d{4,}|[A-Za-z][A-Za-z0-9_]{3,63})$/.test(channel) || !/^\d{1,12}$/.test(msg)) { res.sendStatus(400); return false; }
  if (ALLOWED.length && !ALLOWED.includes(channel.toLowerCase())) { res.sendStatus(403); return false; }
  if (ORIGINS.length) {
    const ref = (req.headers.referer || req.headers.origin || '');
    if (ref && !ORIGINS.some(o => ref.startsWith(o))) { res.sendStatus(403); return false; }
  }
  return true;
}

async function loadInfo(channel, msg) {
  try { return await getInfo(channel, +msg); }
  catch (e) {
    if (/FILE_REFERENCE|CHANNEL_INVALID|PEER_ID/.test(String(e.errorMessage || e.message))) { entities.delete(channel); return await getInfo(channel, +msg, true); }
    throw e;
  }
}

function parseRange(req, size) {
  let start = 0, end = size - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) return null;
    if (m[1] === '') start = Math.max(0, size - parseInt(m[2], 10));
    else { start = parseInt(m[1], 10); if (m[2] !== '') end = Math.min(end, parseInt(m[2], 10)); }
    if (start > end || start >= size) return null;
    status = 206;
  }
  return { start, end, status };
}

function fail(res, e) {
  const m = String(e.errorMessage || e.message || e);
  console.error('error:', m.replace(BOT_TOKEN || '\u0000', '***'));
  if (res.headersSent) return res.destroy();
  if (/FLOOD/.test(m)) return res.status(429).send('ضغط على تيليجرام، حاول بعد قليل');
  if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID|CHANNEL_PRIVATE/.test(m)) return res.status(404).send('القناة غير متاحة');
  res.status(502).send('تعذر جلب الملف');
}

async function stream(req, res) {
  const { channel, msg } = req.params;
  if (!guard(req, res, channel, msg)) return;
  try {
    const info = await loadInfo(channel, msg);
    if (!info) return res.status(404).send('المقطع غير موجود');
    if (!info.isVideo) return res.status(415).send('الرسالة ليست فيديو');
    const size = info.size, r = parseRange(req, size);
    if (!r) return res.status(416).set('Content-Range', 'bytes */' + size).end();
    res.status(r.status).set({
      'Content-Type': info.vmime,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(r.end - r.start + 1),
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff'
    });
    if (r.status === 206) res.set('Content-Range', `bytes ${r.start}-${r.end}/${size}`);
    if (req.method === 'HEAD') return res.end();
    await pipeRange(info, r.start, r.end, res);
  } catch (e) { fail(res, e); }
}

function safeName(n, fallback) {
  n = String(n || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return n || fallback;
}

function disposition(inline, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function guessPdfMime(mime, name) {
  return mime && mime !== 'application/octet-stream' ? mime : (/\.pdf$/i.test(name) ? 'application/pdf' : 'application/octet-stream');
}

async function fileByMessage(req, res) {
  const { channel, msg } = req.params;
  if (!guard(req, res, channel, msg)) return;
  try {
    const info = await loadInfo(channel, msg);
    if (!info) return res.status(404).send('الملف غير موجود');
    if (info.isVideo) return res.status(415).send('هذه الرسالة فيديو، استخدم مسار /v');
    const size = info.size, r = parseRange(req, size);
    if (!r) return res.status(416).set('Content-Range', 'bytes */' + size).end();
    let name = safeName(req.query.n, '');
    const orig = info.name || 'file.pdf';
    if (name && !/\.[A-Za-z0-9]{2,5}$/.test(name)) name += (orig.match(/\.[A-Za-z0-9]{2,5}$/) || ['.pdf'])[0];
    name = name || safeName(orig, 'file.pdf');
    res.status(r.status).set({
      'Content-Type': guessPdfMime(info.mime, orig),
      'Accept-Ranges': 'bytes',
      'Content-Length': String(r.end - r.start + 1),
      'Content-Disposition': disposition(req.query.inline === '1', name),
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });
    if (r.status === 206) res.set('Content-Range', `bytes ${r.start}-${r.end}/${size}`);
    if (req.method === 'HEAD') return res.end();
    await pipeRange(info, r.start, r.end, res);
  } catch (e) { fail(res, e); }
}

const botPaths = new Map();

async function fileById(req, res) {
  if (!BOT_TOKEN) return res.status(501).send('BOT_TOKEN غير مضبوط في الخدمة');
  const id = req.params.fileId;
  if (!/^[A-Za-z0-9_-]{20,250}$/.test(id)) return res.sendStatus(400);
  if (ORIGINS.length) {
    const ref = (req.headers.referer || req.headers.origin || '');
    if (ref && !ORIGINS.some(o => ref.startsWith(o))) return res.sendStatus(403);
  }
  try {
    let hit = botPaths.get(id);
    if (!hit || hit.exp < Date.now()) {
      const j = await (await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(id)}`)).json();
      if (!j.ok || !j.result || !j.result.file_path) return res.status(404).send('File ID غير صالح أو أن الملف أكبر من 20MB');
      hit = { path: j.result.file_path, exp: Date.now() + 40 * 60 * 1000 };
      botPaths.set(id, hit);
    }
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const up = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${hit.path}`, { headers });
    if (!up.ok && up.status !== 206) { botPaths.delete(id); return res.status(up.status === 416 ? 416 : 502).send('تعذر جلب الملف'); }
    const base = hit.path.split('/').pop();
    const name = safeName(req.query.n, '')
      ? (safeName(req.query.n, '') + (/\.[A-Za-z0-9]{2,5}$/.test(req.query.n) ? '' : (base.match(/\.[A-Za-z0-9]{2,5}$/) || ['.pdf'])[0]))
      : safeName(base, 'file.pdf');
    res.status(up.status).set({
      'Content-Type': guessPdfMime('', name),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': disposition(req.query.inline === '1', name),
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });
    ['content-length', 'content-range'].forEach(h => { const v = up.headers.get(h); if (v) res.set(h, v); });
    if (req.method === 'HEAD') { up.body && up.body.cancel(); return res.end(); }
    const { Readable } = require('stream');
    const rs = Readable.fromWeb(up.body);
    res.on('close', () => rs.destroy());
    rs.on('error', () => res.destroy());
    rs.pipe(res);
  } catch (e) { fail(res, e); }
}

app.get('/v/:channel/:msg', stream);
app.head('/v/:channel/:msg', stream);
app.get('/f/:channel/:msg', fileByMessage);
app.head('/f/:channel/:msg', fileByMessage);
app.get('/fid/:fileId', fileById);
app.head('/fid/:fileId', fileById);

const pub = path.join(__dirname, 'public');
if (fs.existsSync(pub)) app.use(express.static(pub));

(async () => {
  await client.connect();
  console.log('متصل بتيليجرام');
  app.listen(PORT, () => console.log('يعمل على المنفذ ' + PORT));
})().catch(e => { console.error(e); process.exit(1); });
