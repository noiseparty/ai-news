'use strict';

/**
 * Link preview: fetch a URL and pull out title / description / image / site name
 * from OpenGraph, Twitter-card and plain HTML tags.
 *
 * Only an authenticated admin can trigger a fetch, but the server sits on a box
 * full of loopback-only services, so every hop (including redirects) is checked
 * against private/loopback address ranges before we connect. There is a small
 * DNS-rebinding window between the check and the connect; acceptable for an
 * admin-only feature.
 */

const dns = require('dns').promises;
const net = require('net');

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (compatible; ai-news-preview/1.0; link preview for a personal newsfeed)';

function normalizeUrl(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  // Strip common tracking params so the same article isn't posted twice.
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref_src$|igshid$)/i.test(key)) u.searchParams.delete(key);
  }
  return u.toString();
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`Refusing to fetch private/internal address (${hostname})`);
  }
}

async function readLimited(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks);
}

function decodeBody(buf, contentType) {
  const charset = /charset=([^;]+)/i.exec(contentType || '')?.[1]?.trim();
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

async function fetchHtml(startUrl) {
  let url = startUrl;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(url);
    await assertPublicHost(u.hostname);
    const res = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Site answered HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!/html|xml/i.test(type)) return { finalUrl: url, html: '' };
    return { finalUrl: url, html: decodeBody(await readLimited(res, MAX_BYTES), type) };
  }
  throw new Error('Too many redirects');
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', copy: '©',
  reg: '®', trade: '™', laquo: '«', raquo: '»', bull: '•',
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function clean(s) {
  return s ? decodeEntities(s).replace(/\s+/g, ' ').trim() : '';
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return attrs;
}

/** Pure function: HTML string in, preview fields out. */
function parseMeta(html, pageUrl) {
  const head = html.slice(0, 600_000);
  const meta = {};
  for (const tag of head.match(/<meta\s[^>]*>/gi) || []) {
    const a = parseAttrs(tag);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content != null && !(key in meta)) meta[key] = a.content;
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];

  let image = meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || '';
  if (image) {
    try {
      image = new URL(decodeEntities(image.trim()), pageUrl).toString();
      if (!/^https?:/.test(image)) image = '';
    } catch {
      image = '';
    }
  }

  const host = new URL(pageUrl).hostname.replace(/^www\./, '');
  return {
    title: clean(meta['og:title'] || meta['twitter:title'] || titleTag || ''),
    description: clean(meta['og:description'] || meta['twitter:description'] || meta.description || ''),
    image,
    siteName: clean(meta['og:site_name'] || meta['application-name'] || '') || host,
    publishedAt: clean(meta['article:published_time'] || meta['og:published_time'] || meta.date || '') || null,
  };
}

async function fetchMeta(url) {
  const { finalUrl, html } = await fetchHtml(url);
  return { url: normalizeUrl(finalUrl) || url, ...parseMeta(html, finalUrl) };
}

module.exports = { fetchMeta, parseMeta, normalizeUrl, isPrivateAddress, decodeEntities };
