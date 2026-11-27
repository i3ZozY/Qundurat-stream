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
const entityPending = new Map();
let dialogsPending = null;
const infos = new Map();
const infoPending = new Map();
let dialogsLoaded = false;

// اتصل بتيليجرام عند أول طلب ملف فقط، وافصل الاتصال بعد فترة خمول.
// هذا لا يغيّر ساعات Render مباشرة، لكنه يمنع إبقاء جلسة تيليجرام مفتوحة بلا حاجة.
let tgConnected = false;
let tgConnecting = null;
let tgDisconnecting = null;
let tgIdleTimer = null;
let tgActiveResponses = 0;
const TG_IDLE_MS = 5 * 60 * 1000;

async function ensureTelegramConnected() {
  clearTimeout(tgIdleTimer);
  // انتظر الفصل الجاري قبل محاولة الاتصال؛ يمنع سباق disconnect/connect.
  if (tgDisconnecting) await tgDisconnecting;
  if (tgConnected) return;
  if (!tgConnecting) {
    tgConnecting = client.connect()
      .then(() => { tgConnected = true; })
      .finally(() => { tgConnecting = null; });
  }
  await tgConnecting;
}

function trackTelegramResponse(res) {
  tgActiveResponses++;
  clearTimeout(tgIdleTimer);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    tgActiveResponses = Math.max(0, tgActiveResponses - 1);
    if (tgActiveResponses !== 0) return;
    tgIdleTimer = setTimeout(() => {
      if (tgActiveResponses !== 0 || !tgConnected || tgDisconnecting) return;
      tgDisconnecting = (async () => {
        if (tgConnecting) await tgConnecting;
        if (tgActiveResponses !== 0 || !tgConnected) return;
        await client.disconnect();
        tgConnected = false;
        entities.clear();
        dialogsLoaded = false;
      })().catch(e => {
        console.warn('تعذر فصل اتصال تيليجرام بعد الخمول:', String(e.message || e));
      }).finally(() => { tgDisconnecting = null; });
    }, TG_IDLE_MS);
    if (tgIdleTimer.unref) tgIdleTimer.unref();
  };
  res.once('finish', release);
  res.once('close', release);
}

async function getEntity(channel) {
  await ensureTelegramConnected();
  if (entities.has(channel)) {
    const cached = entities.get(channel);
    entities.delete(channel); entities.set(channel, cached);
    return cached;
  }
  // شارك عملية جلب الكيان بين الطلبات المتزامنة للقناة نفسها.
  if (entityPending.has(channel)) return entityPending.get(channel);
  const task = (async () => {
    let ent;
    if (/^c\d+$/.test(channel)) {
      // getDialogs مكلف؛ لا تشغّله أكثر من مرة عند بدء الخدمة بالتزامن.
      if (!dialogsLoaded) {
        if (!dialogsPending) {
          dialogsPending = client.getDialogs({ limit: 500 })
            .then(() => { dialogsLoaded = true; })
            .finally(() => { dialogsPending = null; });
        }
        await dialogsPending;
      }
      ent = await client.getEntity(new Api.PeerChannel({ channelId: bigInt(channel.slice(1)) }));
    } else {
      ent = await client.getEntity(channel);
    }
    entities.set(channel, ent);
    while (entities.size > 150) entities.delete(entities.keys().next().value);
    return ent;
  })();
  entityPending.set(channel, task);
  try { return await task; }
  finally { if (entityPending.get(channel) === task) entityPending.delete(channel); }
}

async function fetchInfo(channel, msgId, force) {
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
    // استخدم MIME الأصلي، أو استنتجه من الامتداد عند غيابه؛ لا نغيّر محتوى الملف.
    vmime: mime.startsWith('video/') ? mime : ({'.mp4':'video/mp4','.m4v':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.mkv':'video/x-matroska','.avi':'video/x-msvideo','.mpeg':'video/mpeg','.mpg':'video/mpeg','.3gp':'video/3gpp'}[path.extname(fn ? fn.fileName : '').toLowerCase()] || mime || 'application/octet-stream'),
    exp: Date.now() + 30 * 60 * 1000
  };
  infos.set(key, info);
  // حد أقصى للكاش حتى لا يتضخم مع كثرة الملفات والطلاب.
  while (infos.size > 800) infos.delete(infos.keys().next().value);
  return info;
}

async function getInfo(channel, msgId, force) {
  const key = channel + '/' + msgId;
  const hit = infos.get(key);
  if (hit && !force && hit.exp > Date.now()) {
    // اجعل العنصر المستخدم حديثاً في نهاية Map (LRU بسيط).
    infos.delete(key); infos.set(key, hit);
    return hit;
  }
  if (!force && infoPending.has(key)) return infoPending.get(key);
  const task = fetchInfo(channel, msgId, force);
  if (!force) infoPending.set(key, task);
  try { return await task; }
  finally { if (infoPending.get(key) === task) infoPending.delete(key); }
}

function waitDrainOrClose(res) {
  return new Promise(resolve => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.once('drain', done); res.once('close', done);
  });
}

async function pipeRange(info, start, end, res) {
  await ensureTelegramConnected();
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
  // إذا أغلق الطالب الصفحة أو انتقل لمقطع آخر، أوقف قراءة تيليجرام بأسرع ما يمكن.
  const stopDownload = () => {
    closed = true;
    if (it && typeof it.return === 'function') Promise.resolve(it.return()).catch(() => {});
  };
  res.once('close', stopDownload);
  for await (const chunk of it) {
    if (closed) break;
    let buf = Buffer.from(chunk);
    if (skip) { buf = buf.subarray(skip); skip = 0; }
    if (buf.length > remain) buf = buf.subarray(0, remain);
    remain -= buf.length;
    if (!res.write(buf)) await waitDrainOrClose(res);
    if (remain <= 0) break;
  }
  res.off('close', stopDownload);
  if (!closed) res.end();
}

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  const origin = (req.headers.origin || '').replace(/\/$/, '');
  if (origin && ORIGINS.length && !ORIGINS.includes(origin)) return res.sendStatus(403);
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  else if (!ORIGINS.length) res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (req, res) => res.send('ok'));

function isAllowedRef(req) {
  if (!ORIGINS.length) return true;
  const ref = req.headers.origin || req.headers.referer || '';
  if (!ref) return true; // لا نعتمد على Referer كوسيلة مصادقة؛ CORS يضبط المتصفحات.
  try {
    const refOrigin = new URL(ref).origin;
    return ORIGINS.some(o => {
      try { return new URL(o).origin === refOrigin; } catch (_) { return false; }
    });
  } catch (_) { return false; }
}

function guard(req, res, channel, msg) {
  if (!/^(c\d{4,}|[A-Za-z][A-Za-z0-9_]{3,63})$/.test(channel) || !/^\d{1,12}$/.test(msg)) { res.sendStatus(400); return false; }
  if (ALLOWED.length && !ALLOWED.includes(channel.toLowerCase())) { res.sendStatus(403); return false; }
  if (!isAllowedRef(req)) { res.sendStatus(403); return false; }
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
  if (!Number.isSafeInteger(size) || size < 0) return null;
  let start = 0, end = size - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!m || (m[1] === '' && m[2] === '') || size === 0) return null;
    if (m[1] === '') {
      const suffix = Number(m[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
      start = Math.max(0, size - suffix);
    } else {
      start = Number(m[1]);
      if (!Number.isSafeInteger(start)) return null;
      if (m[2] !== '') {
        const requestedEnd = Number(m[2]);
        if (!Number.isSafeInteger(requestedEnd)) return null;
        end = Math.min(end, requestedEnd);
      }
    }
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
  // احتساب الطلب من بداية استخدام مسار تيليجرام، حتى يشمل HEAD والأخطاء أيضاً.
  trackTelegramResponse(res);
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
      'Cache-Control': 'private, max-age=86400',
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
  // إبقاء الاتصال أثناء الطلب فقط، ثم بدء مؤقت الخمول بعد انتهاء الاستجابة.
  trackTelegramResponse(res);
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
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff'
    });
    if (r.status === 206) res.set('Content-Range', `bytes ${r.start}-${r.end}/${size}`);
    if (req.method === 'HEAD') return res.end();
    await pipeRange(info, r.start, r.end, res);
  } catch (e) { fail(res, e); }
}

const botPaths = new Map();
const botPathPending = new Map();
const BOT_PATHS_MAX = 500;

async function getBotPath(id) {
  const now = Date.now();
  const hit = botPaths.get(id);
  if (hit && hit.exp > now) {
    botPaths.delete(id); botPaths.set(id, hit);
    return hit;
  }
  if (botPathPending.has(id)) return botPathPending.get(id);
  const task = (async () => {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error('Telegram Bot API HTTP ' + response.status);
    const j = await response.json();
    if (!j.ok || !j.result || !j.result.file_path) throw new Error('BOT_FILE_NOT_FOUND');
    const value = { path: j.result.file_path, exp: Date.now() + 40 * 60 * 1000 };
    botPaths.set(id, value);
    while (botPaths.size > BOT_PATHS_MAX) botPaths.delete(botPaths.keys().next().value);
    return value;
  })();
  botPathPending.set(id, task);
  try { return await task; }
  finally { if (botPathPending.get(id) === task) botPathPending.delete(id); }
}

async function fileById(req, res) {
  if (!BOT_TOKEN) return res.status(501).send('BOT_TOKEN غير مضبوط في الخدمة');
  const id = req.params.fileId;
  if (!/^[A-Za-z0-9_-]{20,250}$/.test(id)) return res.sendStatus(400);
  if (!isAllowedRef(req)) return res.sendStatus(403);
  try {
    let hit;
    try { hit = await getBotPath(id); }
    catch (e) {
      if (String(e.message || e) === 'BOT_FILE_NOT_FOUND') return res.status(404).send('File ID غير صالح أو أن الملف أكبر من حد Telegram Bot API');
      throw e;
    }
    const base = hit.path.split('/').pop();
    const name = safeName(req.query.n, '')
      ? (safeName(req.query.n, '') + (/\.[A-Za-z0-9]{2,5}$/.test(req.query.n) ? '' : (base.match(/\.[A-Za-z0-9]{2,5}$/) || ['.pdf'])[0]))
      : safeName(base, 'file.pdf');
    if (req.method === 'HEAD') {
      res.status(200).set({
        'Content-Type': guessPdfMime('', name),
        'Accept-Ranges': 'bytes',
        'Content-Disposition': disposition(req.query.inline === '1', name),
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff'
      }).end();
      return;
    }
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const up = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${hit.path}`, { headers });
    if (!up.ok && up.status !== 206) { botPaths.delete(id); return res.status(up.status === 416 ? 416 : 502).send('تعذر جلب الملف'); }
    res.status(up.status).set({
      'Content-Type': guessPdfMime('', name),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': disposition(req.query.inline === '1', name),
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff'
    });
    ['content-length', 'content-range'].forEach(h => { const v = up.headers.get(h); if (v) res.set(h, v); });
    if (req.method === 'HEAD') { if (up.body) up.body.cancel().catch(() => {}); return res.end(); }
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

const server = app.listen(PORT, '0.0.0.0', () => console.log('يعمل على المنفذ ' + PORT + '؛ اتصال تيليجرام عند الطلب فقط'));
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
