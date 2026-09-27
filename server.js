#!/usr/bin/env node
'use strict';

/**
 * AI news feed: a hand-curated, newsletter-style list of links with optional
 * commentary, grouped by category, with RSS and an email sign-up list.
 *
 * Zero npm dependencies, JSON files for storage, one process. Binds 127.0.0.1
 * by default and expects a reverse proxy (Caddy) in front for TLS.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JsonStore } = require('./lib/store');
const { fetchMeta, normalizeUrl } = require('./lib/meta');
const { CATEGORIES, DEFAULT_CATEGORY, isCategory } = require('./lib/categories');
const render = require('./lib/render');

const PORT = Number(process.env.PORT || 8931);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

const SITE = {
  title: process.env.SITE_TITLE || 'AI Dispatch',
  tagline: process.env.SITE_TAGLINE || 'The AI news worth your time, with notes.',
  author: process.env.SITE_AUTHOR || '',
  baseUrl: (process.env.BASE_URL || '').replace(/\/+$/, ''),
  tz: process.env.SITE_TZ || 'Europe/Riga',
};

const PAGE_SIZE = 30;
const RSS_SIZE = 50;
const MAX_BODY = 64 * 1024;
const COOKIE = 'ain_session';
const SECURE_COOKIE = SITE.baseUrl.startsWith('https://');

const items = new JsonStore(path.join(DATA_DIR, 'items.json'), []);
const subscribers = new JsonStore(path.join(DATA_DIR, 'subscribers.json'), []);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'content-security-policy': "default-src 'self'; img-src * data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...extra,
  });
  res.end(body);
}
const html = (res, status, body, extra) => send(res, status, body, 'text/html; charset=utf-8', { 'cache-control': 'no-cache', ...extra });
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'cache-control': 'no-store' });
const redirect = (res, location, extra = {}) => { res.writeHead(303, { location, ...extra }); res.end(); };

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] || '';
  if (type.startsWith('application/json')) {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function clientIp(req) {
  // Caddy strips any client-sent X-Forwarded-For and appends the real peer, so the last entry is trustworthy.
  return (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
}

function baseUrl(req) {
  return SITE.baseUrl || `http://${req.headers.host || `${HOST}:${PORT}`}`;
}

/** Fixed-window limiter: at most `max` hits per key per window. */
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) {
      hits.set(key, { start: now, n: 1 });
      if (hits.size > 10_000) hits.clear();
      return true;
    }
    return ++h.n <= max;
  };
}
const subscribeLimit = limiter(10, 60 * 60_000);
const loginLimit = limiter(10, 15 * 60_000);

// ---------------------------------------------------------------------------
// Auth: one admin password (ADMIN_TOKEN). Browser gets an HMAC session cookie;
// scripts send "Authorization: Bearer <token>". Rotating the token logs out every session.
// ---------------------------------------------------------------------------

const sessionValue = () => crypto.createHmac('sha256', ADMIN_TOKEN).update('ai-news-admin-v1').digest('base64url');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  if (bearer) return safeEqual(bearer, ADMIN_TOKEN);
  const cookie = getCookie(req, COOKIE);
  return cookie ? safeEqual(cookie, sessionValue()) : false;
}

function requireApiAdmin(req) {
  if (!isAdmin(req)) throw new HttpError(401, 'Not signed in');
  // CSRF: cookie-authenticated writes must carry a custom header. A cross-site page
  // can't add one without a CORS preflight, which this server never answers.
  if (req.method !== 'GET' && !req.headers.authorization && req.headers['x-requested-with'] !== 'fetch') {
    throw new HttpError(403, 'Missing X-Requested-With header');
  }
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const str = (v, max) => String(v ?? '').trim().slice(0, max);

function sanitizeImage(v) {
  const u = normalizeUrl(v);
  return u && /^https?:/.test(u) ? u : '';
}

function applyFields(item, body) {
  if ('title' in body) item.title = str(body.title, 300);
  if ('description' in body) item.description = str(body.description, 1000);
  if ('siteName' in body) item.siteName = str(body.siteName, 100) || item.siteName;
  if ('image' in body) item.image = sanitizeImage(body.image);
  if ('comment' in body) item.comment = String(body.comment ?? '').trim().slice(0, 5000);
  if ('category' in body) {
    if (!isCategory(body.category)) throw new HttpError(400, `Unknown category. Use one of: ${CATEGORIES.map((c) => c.id).join(', ')}`);
    item.category = body.category;
  }
  if (!item.title) throw new HttpError(422, 'Title is required');
  return item;
}

async function createItem(body) {
  const url = normalizeUrl(body.url);
  if (!url) throw new HttpError(400, 'A valid http(s) link is required');
  const existing = items.data.find((i) => i.url === url);
  if (existing) throw Object.assign(new HttpError(409, 'This link is already posted'), { id: existing.id });

  let meta = { title: '', description: '', image: '', siteName: new URL(url).hostname.replace(/^www\./, '') };
  if (!str(body.title, 300)) {
    try {
      meta = await fetchMeta(url);
    } catch (err) {
      throw new HttpError(422, `Couldn't read the page (${err.message}). Enter a title manually.`);
    }
  }

  const item = applyFields({
    id: crypto.randomBytes(6).toString('base64url'),
    url,
    title: str(meta.title, 300),
    description: str(meta.description, 1000),
    image: meta.image,
    siteName: str(meta.siteName, 100),
    category: DEFAULT_CATEGORY,
    comment: '',
    addedAt: new Date().toISOString(),
  }, Object.fromEntries(Object.entries(body).filter(([k, v]) => k !== 'url' && v != null && v !== '')));

  items.data.unshift(item);
  items.save();
  return item;
}

function categoryCounts() {
  const counts = {};
  for (const i of items.data) counts[i.category] = (counts[i.category] || 0) + 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const STATIC = { '/style.css': 'text/css; charset=utf-8', '/admin.js': 'text/javascript; charset=utf-8' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;

  if (m === 'GET' && STATIC[p]) {
    return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, p)), STATIC[p], { 'cache-control': 'public, max-age=300' });
  }

  if (m === 'GET' && p === '/api/health') {
    return json(res, 200, { ok: true, items: items.data.length });
  }

  if (m === 'GET' && p === '/') {
    return html(res, 200, render.home({ site: SITE, items: items.data, counts: categoryCounts(), notice: url.searchParams.get('subscribed') }));
  }

  let match = /^\/c\/([a-z-]+)$/.exec(p);
  if (m === 'GET' && match) {
    const cat = CATEGORIES.find((c) => c.id === match[1]);
    if (!cat) throw new HttpError(404, 'No such category');
    const list = items.data.filter((i) => i.category === cat.id);
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const page = Math.min(pages, Math.max(1, Number(url.searchParams.get('page')) || 1));
    return html(res, 200, render.category({
      site: SITE, cat, counts: categoryCounts(), page, pages,
      items: list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    }));
  }

  match = /^(?:\/c\/([a-z-]+))?\/feed\.xml$/.exec(p);
  if (m === 'GET' && match) {
    const cat = match[1] ? CATEGORIES.find((c) => c.id === match[1]) : null;
    if (match[1] && !cat) throw new HttpError(404, 'No such category');
    const list = cat ? items.data.filter((i) => i.category === cat.id) : items.data;
    return send(res, 200, render.rss({ site: SITE, cat, items: list.slice(0, RSS_SIZE), baseUrl: baseUrl(req) }),
      'application/rss+xml; charset=utf-8', { 'cache-control': 'public, max-age=300' });
  }

  if (m === 'POST' && p === '/subscribe') {
    const body = await readBody(req);
    const email = str(body.email, 254).toLowerCase();
    let notice;
    if (body.website) notice = 'ok'; // honeypot: bots fill the hidden field, pretend success
    else if (!subscribeLimit(clientIp(req))) notice = 'limited';
    else if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) notice = 'invalid';
    else if (subscribers.data.some((s) => s.email === email)) notice = 'exists';
    else {
      subscribers.data.push({ email, subscribedAt: new Date().toISOString() });
      subscribers.save();
      notice = 'ok';
    }
    return redirect(res, `/?subscribed=${notice}#subscribe`);
  }

  // --- admin pages -------------------------------------------------------

  if (m === 'GET' && p === '/admin') {
    if (!isAdmin(req)) return html(res, ADMIN_TOKEN ? 200 : 503, render.login({ site: SITE, disabled: !ADMIN_TOKEN }));
    return html(res, 200, render.admin({
      site: SITE, items: items.data, subscriberCount: subscribers.data.length, prefillUrl: url.searchParams.get('url'),
    }));
  }

  if (m === 'POST' && p === '/admin/login') {
    if (!ADMIN_TOKEN) return html(res, 503, render.login({ site: SITE, disabled: true }));
    if (!loginLimit(clientIp(req))) return html(res, 429, render.login({ site: SITE, error: 'Too many attempts. Wait 15 minutes.' }));
    const body = await readBody(req);
    if (!safeEqual(body.token || '', ADMIN_TOKEN)) return html(res, 401, render.login({ site: SITE, error: 'Wrong password.' }));
    return redirect(res, '/admin', { 'set-cookie': sessionCookie(sessionValue(), 60 * 60 * 24 * 30) });
  }

  if (m === 'POST' && p === '/admin/logout') {
    return redirect(res, '/', { 'set-cookie': sessionCookie('', 0) });
  }

  if (m === 'GET' && p === '/admin/subscribers.csv') {
    if (!isAdmin(req)) return redirect(res, '/admin');
    const csv = ['email,subscribed_at', ...subscribers.data.map((s) => `${s.email},${s.subscribedAt}`)].join('\n');
    return send(res, 200, csv, 'text/csv; charset=utf-8', { 'content-disposition': 'attachment; filename="subscribers.csv"', 'cache-control': 'no-store' });
  }

  // --- admin API ---------------------------------------------------------

  if (p === '/api/preview' && m === 'POST') {
    requireApiAdmin(req);
    const body = await readBody(req);
    const target = normalizeUrl(body.url);
    if (!target) throw new HttpError(400, 'A valid http(s) link is required');
    const existing = items.data.find((i) => i.url === target);
    try {
      return json(res, 200, { ...(await fetchMeta(target)), duplicateOf: existing?.id || null });
    } catch (err) {
      return json(res, 200, { url: target, title: '', description: '', image: '', siteName: new URL(target).hostname.replace(/^www\./, ''), error: err.message, duplicateOf: existing?.id || null });
    }
  }

  if (p === '/api/items' && m === 'GET') {
    requireApiAdmin(req);
    return json(res, 200, items.data);
  }

  if (p === '/api/items' && m === 'POST') {
    requireApiAdmin(req);
    return json(res, 201, await createItem(await readBody(req)));
  }

  match = /^\/api\/items\/([\w-]+)$/.exec(p);
  if (match && (m === 'PATCH' || m === 'DELETE')) {
    requireApiAdmin(req);
    const idx = items.data.findIndex((i) => i.id === match[1]);
    if (idx === -1) throw new HttpError(404, 'No such post');
    if (m === 'DELETE') {
      items.data.splice(idx, 1);
      items.save();
      return json(res, 200, { ok: true });
    }
    const body = await readBody(req);
    const updated = applyFields({ ...items.data[idx] }, body);
    items.data[idx] = updated;
    items.save();
    return json(res, 200, updated);
  }

  throw new HttpError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.end();
    const message = status === 500 ? 'Something went wrong' : err.message;
    if (req.url.startsWith('/api/')) return json(res, status, { error: message, ...(err.id ? { id: err.id } : {}) });
    html(res, status, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><main class="wrap narrow"><h1>${status}</h1><p>${render.esc(message)}</p><p><a href="/">← Home</a></p></main>`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`${SITE.title} listening on http://${HOST}:${PORT}`);
  if (!ADMIN_TOKEN) console.warn('ADMIN_TOKEN is not set: /admin is disabled.');
});
