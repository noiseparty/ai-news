'use strict';

/** Server-side HTML + RSS rendering. Every interpolated value goes through esc(). */

const { CATEGORIES, categoryLabel } = require('./categories');

const SECTION_SIZE = 5; // posts per category section on the front page

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Plain-text comment -> paragraphs, line breaks and clickable links. */
function formatComment(text) {
  return String(text || '')
    .trim()
    .split(/\n\s*\n/)
    .map((para) => {
      const html = esc(para).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}" rel="noopener nofollow" target="_blank">${u}</a>`);
      return `<p>${html.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}

const fmt = (tz, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts });
const dayKey = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const dayLabel = (iso, tz) => fmt(tz, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
const shortDate = (iso, tz) => fmt(tz, { day: 'numeric', month: 'short' }).format(new Date(iso));

function layout({ site, title, body, head = '' }) {
  const pageTitle = title ? `${title} · ${site.title}` : site.title;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(site.tagline)}">
<link rel="alternate" type="application/rss+xml" title="${esc(site.title)}" href="/feed.xml">
<link rel="stylesheet" href="/style.css">
${head}
</head>
<body>
${body}
</body>
</html>`;
}

function masthead(site) {
  return `<header class="masthead">
  <a class="brand" href="/">${esc(site.title)}</a>
  <p class="tagline">${esc(site.tagline)}</p>
</header>`;
}

function categoryNav(active, counts) {
  const link = (href, label, on, n) => `<li><a href="${href}"${on ? ' aria-current="page"' : ''}>${esc(label)}${n != null ? ` <span>${n}</span>` : ''}</a></li>`;
  return `<nav class="cats"><ul>
  ${link('/', 'All', !active)}
  ${CATEGORIES.map((c) => link(`/c/${c.id}`, c.label, active === c.id, counts[c.id] || 0)).join('\n  ')}
</ul></nav>`;
}

function subscribeBox(notice) {
  const msg = {
    ok: `<p class="notice ok">You're on the list, thanks. Email delivery isn't switched on yet, so until it is, the <a href="/feed.xml">RSS feed</a> is the way to follow along.</p>`,
    exists: `<p class="notice ok">That address is already on the list.</p>`,
    invalid: `<p class="notice err">That doesn't look like an email address.</p>`,
    limited: `<p class="notice err">Too many attempts, try again later.</p>`,
  }[notice] || '';
  return `<section class="subscribe" id="subscribe">
  <form method="post" action="/subscribe">
    <label for="sub-email">Get new posts in your inbox</label>
    <div class="row">
      <input id="sub-email" type="email" name="email" placeholder="you@example.com" required maxlength="254" autocomplete="email">
      <input type="text" name="website" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button type="submit">Subscribe</button>
    </div>
    <p class="hint">Or follow with <a href="/feed.xml">RSS</a>.</p>
  </form>
  ${msg}
</section>`;
}

function itemHtml(item, tz, { showDate = true } = {}) {
  const img = item.image
    ? `<a class="thumb" href="${esc(item.url)}" target="_blank" rel="noopener"><img src="${esc(item.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>`
    : '';
  const note = item.comment
    ? `<div class="note"><span class="note-label">My take</span>${formatComment(item.comment)}</div>`
    : '';
  return `<article class="item" id="item-${esc(item.id)}">
  <div class="item-main">
    <p class="source">${esc(item.siteName)}${showDate ? ` · <time datetime="${esc(item.addedAt)}">${esc(shortDate(item.addedAt, tz))}</time>` : ''}</p>
    <h3><a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.title)}</a></h3>
    ${item.description ? `<p class="desc">${esc(item.description)}</p>` : ''}
  </div>
  ${img}
  ${note}
</article>`;
}

function footer(site, notice) {
  return `<footer class="foot">
  ${subscribeBox(notice)}
  <p>${esc(site.title)}${site.author ? ` · curated by ${esc(site.author)}` : ''} · <a href="/feed.xml">RSS</a></p>
</footer>`;
}

/** Front page: one section per category, latest few posts each. */
function home({ site, items, counts, notice }) {
  const sections = CATEGORIES
    .map((c) => ({ ...c, items: items.filter((i) => i.category === c.id) }))
    .filter((c) => c.items.length)
    .map((c) => `<section class="section" id="${c.id}">
  <h2><a href="/c/${c.id}">${esc(c.label)}</a></h2>
  ${c.items.slice(0, SECTION_SIZE).map((i) => itemHtml(i, site.tz)).join('\n')}
  ${c.items.length > SECTION_SIZE ? `<p class="more"><a href="/c/${c.id}">All ${c.items.length} in ${esc(c.label)} →</a></p>` : ''}
</section>`)
    .join('\n');

  return layout({
    site,
    body: `<main class="wrap">
${masthead(site)}
${categoryNav(null, counts)}
${subscribeBox(notice)}
${sections || '<p class="empty">No posts yet. Check back soon.</p>'}
${footer(site, '')}
</main>`,
  });
}

/** Category page: every post in one category, newest first, grouped by day. */
function category({ site, cat, items, counts, page, pages }) {
  const groups = [];
  for (const item of items) {
    const key = dayKey(item.addedAt, site.tz);
    if (groups.at(-1)?.key !== key) groups.push({ key, label: dayLabel(item.addedAt, site.tz), items: [] });
    groups.at(-1).items.push(item);
  }
  const feed = groups.length
    ? groups.map((g) => `<section class="day">
  <h3 class="day-label"><span>${esc(g.label)}</span></h3>
  ${g.items.map((i) => itemHtml(i, site.tz, { showDate: false })).join('\n')}
</section>`).join('\n')
    : `<p class="empty">Nothing in ${esc(cat.label)} yet.</p>`;

  const href = (p) => `/c/${cat.id}${p > 1 ? `?page=${p}` : ''}`;
  const pager = pages > 1
    ? `<nav class="pager">${page > 1 ? `<a href="${href(page - 1)}">← Newer</a>` : '<span></span>'}<span>Page ${page} of ${pages}</span>${page < pages ? `<a href="${href(page + 1)}">Older →</a>` : '<span></span>'}</nav>`
    : '';

  return layout({
    site,
    title: cat.label,
    body: `<main class="wrap">
${masthead(site)}
${categoryNav(cat.id, counts)}
<h2 class="page-title">${esc(cat.label)}</h2>
${feed}
${pager}
${footer(site, '')}
</main>`,
  });
}

function login({ site, error, disabled }) {
  return layout({
    site,
    title: 'Sign in',
    body: `<main class="wrap narrow">
${masthead(site)}
${disabled
    ? '<p class="notice err">Admin is disabled: set ADMIN_TOKEN in the environment and restart.</p>'
    : `<form class="card" method="post" action="/admin/login">
  <label for="token">Admin password</label>
  <input id="token" type="password" name="token" required autofocus autocomplete="current-password">
  ${error ? `<p class="notice err">${esc(error)}</p>` : ''}
  <button type="submit">Sign in</button>
</form>`}
</main>`,
  });
}

function admin({ site, items, subscriberCount, prefillUrl }) {
  // JSON for admin.js; "<" is escaped so no string can close the script tag.
  const data = JSON.stringify(items).replace(/</g, '\\u003c');
  return layout({
    site,
    title: 'Admin',
    head: '<meta name="robots" content="noindex"><script src="/admin.js" defer></script>',
    body: `<main class="wrap admin">
<header class="admin-bar">
  <a class="brand small" href="/">${esc(site.title)}</a>
  <form method="post" action="/admin/logout"><button class="link">Sign out</button></form>
</header>

<section class="card" id="compose">
  <h2 id="compose-title">Post a link</h2>
  <form id="post-form" autocomplete="off">
    <input type="hidden" name="id">
    <label for="f-url">Link</label>
    <div class="row">
      <input id="f-url" name="url" type="url" required placeholder="https://…" value="${esc(prefillUrl || '')}">
      <button type="button" id="fetch-btn" class="secondary">Fetch preview</button>
    </div>
    <fieldset class="cat-pick">
      <legend>Category</legend>
      ${CATEGORIES.map((c, n) => `<label><input type="radio" name="category" value="${c.id}"${n === 0 ? ' checked' : ''}> ${esc(c.label)}</label>`).join('\n      ')}
    </fieldset>
    <div id="details" hidden>
      <label for="f-title">Title</label>
      <input id="f-title" name="title" maxlength="300" required>
      <label for="f-desc">Summary</label>
      <textarea id="f-desc" name="description" rows="3" maxlength="1000"></textarea>
      <label for="f-site">Source</label>
      <input id="f-site" name="siteName" maxlength="100">
      <label for="f-image">Image URL</label>
      <input id="f-image" name="image" type="url">
      <img id="img-preview" alt="" hidden referrerpolicy="no-referrer">
    </div>
    <label for="f-comment">Your comment <span class="muted">(optional)</span></label>
    <textarea id="f-comment" name="comment" rows="4" maxlength="5000" placeholder="Why this matters…"></textarea>
    <p id="form-msg" class="notice" hidden></p>
    <div class="row actions">
      <button type="submit" id="submit-btn">Publish</button>
      <button type="button" id="cancel-btn" class="link" hidden>Cancel edit</button>
    </div>
  </form>
</section>

<section class="card">
  <h2>Post from anywhere</h2>
  <p>Drag this to your bookmarks bar. Clicking it on any article opens this form with the link filled in:
    <a id="bookmarklet" class="bookmarklet" href="#">+ ${esc(site.title)}</a></p>
  <p class="muted">From a terminal: <code>node bin/add.js &lt;url&gt; "comment" --cat models</code> (see README).</p>
</section>

<section class="card">
  <h2>Subscribers <span class="count">${subscriberCount}</span></h2>
  <p class="muted">Collected only. Nothing is emailed until a mail provider is wired up. <a href="/admin/subscribers.csv">Download CSV</a></p>
</section>

<section class="card">
  <h2>Posts <span class="count">${items.length}</span></h2>
  <ul class="admin-list">
  ${items.map((i) => `<li data-id="${esc(i.id)}">
    <div><a href="/c/${esc(i.category)}#item-${esc(i.id)}">${esc(i.title)}</a><span class="muted"> · ${esc(categoryLabel(i.category))} · ${esc(i.siteName)} · ${esc(i.addedAt.slice(0, 10))}${i.comment ? ' · 💬' : ''}</span></div>
    <div class="list-actions"><button class="link" data-edit>Edit</button><button class="link danger" data-delete>Delete</button></div>
  </li>`).join('')}
  </ul>
</section>
<script type="application/json" id="items-data">${data}</script>
</main>`,
  });
}

function cdata(s) {
  return `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function rss({ site, items, baseUrl, cat }) {
  const entries = items.map((i) => {
    const body = [
      i.comment ? `<p><strong>My take:</strong></p>${formatComment(i.comment)}` : '',
      i.description ? `<blockquote><p>${esc(i.description)}</p></blockquote>` : '',
      `<p><a href="${esc(i.url)}">Read at ${esc(i.siteName)} →</a></p>`,
    ].join('');
    return `    <item>
      <title>${esc(i.title)}</title>
      <link>${esc(i.url)}</link>
      <guid isPermaLink="false">${esc(baseUrl)}/#item-${esc(i.id)}</guid>
      <pubDate>${new Date(i.addedAt).toUTCString()}</pubDate>
      <category>${esc(categoryLabel(i.category))}</category>
      <description>${cdata(body)}</description>
    </item>`;
  });
  const title = cat ? `${site.title}: ${cat.label}` : site.title;
  const self = cat ? `${baseUrl}/c/${cat.id}/feed.xml` : `${baseUrl}/feed.xml`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(title)}</title>
    <link>${esc(baseUrl)}/${cat ? `c/${cat.id}` : ''}</link>
    <description>${esc(site.tagline)}</description>
    <language>en</language>
    <atom:link href="${esc(self)}" rel="self" type="application/rss+xml"/>
${items[0] ? `    <lastBuildDate>${new Date(items[0].addedAt).toUTCString()}</lastBuildDate>\n` : ''}${entries.join('\n')}
  </channel>
</rss>`;
}

module.exports = { esc, formatComment, home, category, login, admin, rss };
