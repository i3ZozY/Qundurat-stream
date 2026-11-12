/* خدمة بث مقاطع تيليجرام لموقع القندرات
 * GET /v/<channel>/<messageId>   ← يبث الفيديو مع دعم Range (تقديم/تأخير/سحب الشريط) لأي مدة وحجم
 * القناة العامة: t.me/ivv468/110/111  ←  /v/ivv468/111   (رقم الرسالة هو آخر رقم في الرابط)
 * القناة الخاصة: t.me/c/1234567/89    ←  /v/c1234567/89  (يجب أن يكون الحساب عضواً فيها)
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
const ALLOWED = (process.env.ALLOWED_CHANNELS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);

if (!API_ID || !API_HASH || !SESSION) {
  console.error('ناقص: TG_API_ID و TG_API_HASH و TG_SESSION (شغّل gen-session.js لإنشاء الجلسة)');
  process.exit(1);
}
if (!ALLOWED.length) console.warn('تنبيه: ALLOWED_CHANNELS غير محدد، أي قناة عامة يمكن بثها عبر خدمتك. الأفضل تحديد القنوات.');

const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, { connectionRetries: 10 });
const CH = 512 * 1024;                       /* حجم الطلب من تيليجرام (يجب أن يقسم 1MB ويقبل القسمة على 4096) */
const entities = new Map();                  /* channel -> entity */
const infos = new Map();                     /* channel/msg -> {doc,size,mime,exp} */
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
  const isVideo = mime.startsWith('video/') || (doc.attributes || []).some(a => a instanceof Api.DocumentAttributeVideo);
  if (!isVideo) return { notVideo: true };
  const info = {
    doc,
    size: Number(doc.size.toString()),
    mime: /matroska|x-msvideo|quicktime|mpeg$/.test(mime) || !mime.startsWith('video/') ? 'video/mp4' : mime,
    exp: Date.now() + 30 * 60 * 1000          /* مرجع الملف في تيليجرام ينتهي، نجدده كل ٣٠ دقيقة */
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

async function stream(req, res) {
  const { channel, msg } = req.params;
  if (!/^(c\d{4,}|[A-Za-z][A-Za-z0-9_]{3,63})$/.test(channel) || !/^\d{1,12}$/.test(msg)) return res.sendStatus(400);
  if (ALLOWED.length && !ALLOWED.includes(channel.toLowerCase())) return res.sendStatus(403);
  if (ORIGINS.length) {                        /* منع الاستخدام من مواقع أخرى (التحقق من المصدر) */
    const ref = (req.headers.referer || req.headers.origin || '');
    if (ref && !ORIGINS.some(o => ref.startsWith(o))) return res.sendStatus(403);
  }
  try {
    let info;
    try { info = await getInfo(channel, +msg); }
    catch (e) { if (/FILE_REFERENCE|CHANNEL_INVALID|PEER_ID/.test(String(e.errorMessage || e.message))) { entities.delete(channel); info = await getInfo(channel, +msg, true); } else throw e; }
    if (!info) return res.status(404).send('المقطع غير موجود');
    if (info.notVideo) return res.status(415).send('الرسالة ليست فيديو');

    const size = info.size;
    let start = 0, end = size - 1, status = 200;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (m[1] === '' && m[2] === '')) return res.status(416).set('Content-Range', 'bytes */' + size).end();
      if (m[1] === '') start = Math.max(0, size - parseInt(m[2], 10));
      else { start = parseInt(m[1], 10); if (m[2] !== '') end = Math.min(end, parseInt(m[2], 10)); }
      if (start > end || start >= size) return res.status(416).set('Content-Range', 'bytes */' + size).end();
      status = 206;
    }
    res.status(status).set({
      'Content-Type': info.mime,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff'
    });
    if (status === 206) res.set('Content-Range', `bytes ${start}-${end}/${size}`);
    if (req.method === 'HEAD') return res.end();
    await pipeRange(info, start, end, res);
  } catch (e) {
    const msg2 = String(e.errorMessage || e.message || e);
    console.error('stream error:', msg2);
    if (res.headersSent) return res.destroy();
    if (/FLOOD/.test(msg2)) return res.status(429).send('ضغط على تيليجرام، حاول بعد قليل');
    if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID|CHANNEL_PRIVATE/.test(msg2)) return res.status(404).send('القناة غير متاحة');
    res.status(502).send('تعذر جلب المقطع');
  }
}
app.get('/v/:channel/:msg', stream);
app.head('/v/:channel/:msg', stream);

const pub = path.join(__dirname, 'public');   /* اختياري: ضع ملف الموقع هنا باسم index.html ليعمل من نفس الدومين */
if (fs.existsSync(pub)) app.use(express.static(pub));

(async () => {
  await client.connect();
  console.log('متصل بتيليجرام');
  app.listen(PORT, () => console.log('يعمل على المنفذ ' + PORT));
})().catch(e => { console.error(e); process.exit(1); });
