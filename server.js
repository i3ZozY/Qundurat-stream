/* خدمة بث مقاطع تيليجرام ويوتيوب لموقع القندرات (مصحح وجذري) */
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
  console.error('ناقص: TG_API_ID و TG_API_HASH و TG_SESSION');
  process.exit(1);
}

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
  console.error('error:', m);
  if (res.headersSent) return res.destroy();
  res.status(502).send('تعذر المعالجة');
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

/* ============================================================
   يوتيوب — البث عبر خوادم Piped العامة والموثوقة (بدون أثر أو إعلانات)
   ============================================================ */
async function youtubeStream(req, res) {
  const videoId = req.params.id;
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return res.status(400).send('معرف يوتيوب غير صالح');
  }

  // قائمة خوادم Piped موثوقة ومفتوحة المصدر لتوزيع الحمل وضمان عدم التوقف
  const pipedInstances = [
    'https://pipedapi.kavin.rocks',
    'https://api.piped.privacy.com.de',
    'https://piped-api.garudalinux.org'
  ];

  let streamUrl = null;

  for (const instance of pipedInstances) {
    try {
      const response = await fetch(`${instance}/streams/${videoId}`, { 
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000) 
      });
      if (!response.ok) continue;
      const data = await response.json();
      
      const videoStreams = (data.videoStreams || [])
        .filter(v => v.url && v.videoOnly === false)
        .sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));

      if (videoStreams.length > 0) {
        streamUrl = videoStreams[0].url;
        break;
      }
    } catch (err) {
      continue; // تجربة الخادم التالي في حال توقف الأول
    }
  }

  if (!streamUrl) {
    return res.status(502).send('تعذر جلب رابط بث يوتيوب حالياً، حاول مرة أخرى.');
  }

  try {
    const range = req.headers.range;
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (range) headers.Range = range;

    const upstream = await fetch(streamUrl, { headers });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).send('فشل الاتصال بسيرفر البث المباشر');
    }

    res.status(upstream.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    });
    if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'video/mp4');
    if (!res.getHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');

    if (req.method === 'HEAD') {
      upstream.body?.cancel().catch(() => {});
      return res.end();
    }

    const { Readable } = require('stream');
    const rs = Readable.fromWeb(upstream.body);
    res.on('close', () => rs.destroy());
    rs.on('error', () => res.destroy());
    rs.pipe(res);

  } catch (e) {
    console.error('YouTube Stream Error:', e.message);
    if (!res.headersSent) res.status(502).send('خطأ في بث الفيديو');
  }
}

app.get('/v/:channel/:msg', stream);
app.head('/v/:channel/:msg', stream);
app.get('/yt/:id', youtubeStream);
app.head('/yt/:id', youtubeStream);

const pub = path.join(__dirname, 'public');
if (fs.existsSync(pub)) app.use(express.static(pub));

(async () => {
  await client.connect();
  console.log('متصل بتيليجرام بنجاح');
  app.listen(PORT, () => console.log('السيرفر يعمل بكفاءة على المنفذ ' + PORT));
})().catch(e => { console.error(e); process.exit(1); });
