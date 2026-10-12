'use strict';
/* Portfolio server: serves the site, stores content + documents in one SQLite file, and exposes an admin API.
   No npm packages needed. Requires Node.js 22.13 or newer. */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
let PASS = process.env.ADMIN_PASSWORD;
if (!PASS) { PASS = crypto.randomBytes(5).toString('hex'); console.log(`\n  ADMIN_PASSWORD is not set. Temporary admin password for this run: ${PASS}\n`); }
const DBP = process.env.DB_PATH || path.join(__dirname, 'data', 'portfolio.db');
fs.mkdirSync(path.dirname(DBP), { recursive: true });
const db = new DatabaseSync(DBP);
db.exec(`
 CREATE TABLE IF NOT EXISTS content(key TEXT PRIMARY KEY, value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS docs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, cat TEXT DEFAULT 'Other', descr TEXT DEFAULT '',
  file_name TEXT, file_type TEXT, file BLOB, size INTEGER DEFAULT 0, cover BLOB, cover_type TEXT,
  hidden INTEGER DEFAULT 0, sort INTEGER DEFAULT 0, updated INTEGER);`);

const MAX = 15 * 1024 * 1024;
const FILE_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain; charset=utf-8' };
const IMG_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const STATIC = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', svg: 'image/svg+xml' };
const PUBLIC = path.join(__dirname, 'public');

/* ---------- helpers ---------- */
const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); };
const readBody = req => new Promise((resolve, reject) => {
  const ch = []; let n = 0, over = false;
  req.on('data', c => { n += c.length; if (n > MAX) { over = true; return; } if (!over) ch.push(c); });
  req.on('end', () => over ? reject(Object.assign(new Error('File too large (max 15 MB)'), { code: 413 })) : resolve(Buffer.concat(ch)));
  req.on('error', reject);
});
const readJson = async req => { const b = await readBody(req); try { return JSON.parse(b.toString() || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { code: 400 }); } };
const getC = k => { const r = db.prepare('SELECT value FROM content WHERE key=?').get(k); return r ? JSON.parse(r.value) : null; };
const setC = (k, v) => db.prepare('INSERT INTO content(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const extOf = n => String(n || '').split('.').pop().toLowerCase();

/* ---------- auth (password -> short-lived token) ---------- */
const sessions = new Map(), fails = new Map();
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const isAdmin = (req, u) => {
  const h = req.headers.authorization || '', t = h.startsWith('Bearer ') ? h.slice(7) : u.searchParams.get('t');
  const exp = t && sessions.get(t); if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; } return true;
};

/* ---------- content ---------- */
function content(admin) {
  const rows = db.prepare(`SELECT id,name,cat,descr,file_name,size,(cover IS NOT NULL) AS hc,hidden,updated FROM docs
    ${admin ? '' : 'WHERE file IS NOT NULL AND hidden=0'} ORDER BY sort,id`).all();
  return { about: getC('about'), stats: getC('stats'), highlights: getC('highlights'),
    docs: rows.map(d => ({ id: d.id, name: d.name, cat: d.cat, desc: d.descr, fileName: d.file_name, size: d.size, hasCover: !!d.hc, hidden: !!d.hidden, v: d.updated })) };
}

/* ---------- admin routes ---------- */
async function admin(req, res, u, p, m) {
  if (p === '/api/admin/docs' && m === 'GET') return json(res, 200, content(true).docs);
  if (p === '/api/admin/docs' && m === 'POST') {
    const b = await readJson(req), name = str(b.name, 80); if (!name) return json(res, 400, { error: 'Name is required' });
    const sort = (db.prepare('SELECT COALESCE(MAX(sort),-1)+1 AS n FROM docs').get().n);
    const r = db.prepare('INSERT INTO docs(name,cat,descr,sort,updated) VALUES(?,?,?,?,?)').run(name, str(b.cat, 40) || 'Other', str(b.desc, 300), sort, Date.now());
    return json(res, 201, { id: Number(r.lastInsertRowid) });
  }
  if (p === '/api/admin/content' && m === 'PUT') {
    const b = await readJson(req);
    if (!Array.isArray(b.about) || !b.about.length) return json(res, 400, { error: 'Add at least one About paragraph' });
    setC('about', b.about.map(x => str(x, 2000)).filter(Boolean));
    setC('stats', (b.stats || []).slice(0, 8).map(s => [str(s[0], 12), str(s[1], 40)]));
    setC('highlights', (b.highlights || []).slice(0, 20).map(x => str(x, 60)).filter(Boolean));
    return json(res, 200, { ok: true });
  }
  if (p === '/api/admin/reorder' && m === 'POST') {
    const b = await readJson(req); if (!Array.isArray(b.ids)) return json(res, 400, { error: 'ids required' });
    db.exec('BEGIN'); try { b.ids.forEach((id, i) => db.prepare('UPDATE docs SET sort=?,updated=? WHERE id=?').run(i, Date.now(), Number(id))); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    return json(res, 200, { ok: true });
  }
  const mm = p.match(/^\/api\/admin\/docs\/(\d+)(?:\/(file|cover))?$/); if (!mm) return json(res, 404, { error: 'Not found' });
  const id = Number(mm[1]), part = mm[2];
  if (!db.prepare('SELECT 1 FROM docs WHERE id=?').get(id)) return json(res, 404, { error: 'Document not found' });
  if (!part && m === 'PUT') {
    const b = await readJson(req), cur = db.prepare('SELECT name,cat,descr,hidden FROM docs WHERE id=?').get(id);
    db.prepare('UPDATE docs SET name=?,cat=?,descr=?,hidden=?,updated=? WHERE id=?').run(
      str(b.name ?? cur.name, 80) || cur.name, str(b.cat ?? cur.cat, 40) || 'Other', str(b.desc ?? cur.descr, 300), b.hidden === undefined ? cur.hidden : (b.hidden ? 1 : 0), Date.now(), id);
    return json(res, 200, { ok: true });
  }
  if (!part && m === 'DELETE') { db.prepare('DELETE FROM docs WHERE id=?').run(id); return json(res, 200, { ok: true }); }
  if (part && m === 'PUT') {
    const name = str(u.searchParams.get('name'), 120), e = extOf(name);
    const ok = part === 'file' ? FILE_TYPES[e] : IMG_TYPES.includes(e) && FILE_TYPES[e];
    if (!ok) return json(res, 400, { error: part === 'file' ? 'Allowed types: PDF, Word, text or image files' : 'Cover must be a PNG, JPG, GIF or WebP image' });
    const buf = await readBody(req); if (!buf.length) return json(res, 400, { error: 'Empty file' });
    if (part === 'file') db.prepare('UPDATE docs SET file=?,file_name=?,file_type=?,size=?,updated=? WHERE id=?').run(buf, name, FILE_TYPES[e], buf.length, Date.now(), id);
    else db.prepare('UPDATE docs SET cover=?,cover_type=?,updated=? WHERE id=?').run(buf, FILE_TYPES[e], Date.now(), id);
    return json(res, 200, { ok: true });
  }
  return json(res, 405, { error: 'Method not allowed' });
}

/* ---------- server ---------- */
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost'), p = decodeURIComponent(u.pathname), m = req.method;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (p === '/api/login' && m === 'POST') {
      const ip = req.socket.remoteAddress, f = fails.get(ip) || { n: 0, t: Date.now() };
      if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
      if (f.n >= 8) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      const b = await readJson(req);
      if (crypto.timingSafeEqual(sha(b.password), sha(PASS))) { fails.delete(ip); const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, Date.now() + 12 * 3600e3); return json(res, 200, { token: t }); }
      f.n++; fails.set(ip, f); return json(res, 401, { error: 'Wrong password' });
    }
    if (p === '/api/content' && m === 'GET') return json(res, 200, content(false));
    if (p.startsWith('/api/admin/')) { if (!isAdmin(req, u)) return json(res, 401, { error: 'Please sign in' }); return await admin(req, res, u, p, m); }
    const fm = p.match(/^\/files\/(\d+)(\/cover)?$/);
    if (fm && m === 'GET') {
      const d = db.prepare('SELECT file,file_name,file_type,cover,cover_type,hidden FROM docs WHERE id=?').get(Number(fm[1]));
      const blob = d && (fm[2] ? d.cover : d.file);
      if (!blob || (d.hidden && !isAdmin(req, u))) { res.writeHead(404); return res.end('Not found'); }
      const dl = u.searchParams.get('dl') === '1', name = encodeURIComponent(d.file_name || 'document');
      res.writeHead(200, { 'Content-Type': fm[2] ? d.cover_type : d.file_type, 'Content-Length': blob.length, 'Cache-Control': 'private, max-age=0, must-revalidate',
        'Content-Disposition': `${dl ? 'attachment' : 'inline'}; filename*=UTF-8''${name}` });
      return res.end(Buffer.from(blob));
    }
    if (m !== 'GET') { res.writeHead(405); return res.end(); }
    const rel = p === '/' ? '/portfolio.html' : p === '/admin' ? '/admin.html' : p, fp = path.join(PUBLIC, rel);
    if (!fp.startsWith(PUBLIC + path.sep) || !fs.existsSync(fp) || !fs.statSync(fp).isFile() || !STATIC[extOf(fp)]) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': STATIC[extOf(fp)], 'Cache-Control': extOf(fp) === 'html' ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(fp).pipe(res);
  } catch (e) { console.error(e); if (!res.headersSent) json(res, e.code === 413 || e.code === 400 ? e.code : 500, { error: e.code ? e.message : 'Server error' }); else res.end(); }
}).listen(PORT, () => console.log(`Portfolio running on http://localhost:${PORT}   (admin: http://localhost:${PORT}/admin)`));
