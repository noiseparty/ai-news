'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseMeta, normalizeUrl, isPrivateAddress, decodeEntities } = require('../lib/meta');
const { esc, formatComment } = require('../lib/render');

test('parseMeta prefers OpenGraph and resolves relative images', () => {
  const html = `<html><head>
    <title>Fallback title</title>
    <meta property="og:title" content="GPT &amp; friends &#8212; a review">
    <meta content='Short summary' property='og:description'>
    <meta property="og:image" content="/img/cover.png">
    <meta property="og:site_name" content="Example News">
  </head></html>`;
  const m = parseMeta(html, 'https://www.example.com/post/1');
  assert.equal(m.title, 'GPT & friends — a review');
  assert.equal(m.description, 'Short summary');
  assert.equal(m.image, 'https://www.example.com/img/cover.png');
  assert.equal(m.siteName, 'Example News');
});

test('parseMeta falls back to <title>, meta description and hostname', () => {
  const m = parseMeta('<title>\n  Plain page </title><meta name="description" content="Desc">', 'https://www.arxiv.org/abs/1');
  assert.equal(m.title, 'Plain page');
  assert.equal(m.description, 'Desc');
  assert.equal(m.siteName, 'arxiv.org');
  assert.equal(m.image, '');
});

test('parseMeta drops non-http image schemes', () => {
  const m = parseMeta('<meta property="og:image" content="javascript:alert(1)">', 'https://a.com/');
  assert.equal(m.image, '');
});

test('normalizeUrl strips tracking params and hash, rejects non-http', () => {
  assert.equal(normalizeUrl('https://a.com/x?utm_source=tw&id=5#top'), 'https://a.com/x?id=5');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('isPrivateAddress', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('decodeEntities ignores invalid code points', () => {
  assert.equal(decodeEntities('&#99999999;&lt;'), '&#99999999;<');
});

test('formatComment escapes HTML, keeps paragraphs and links URLs', () => {
  const out = formatComment('<b>hi</b>\nline two\n\nsee https://x.com/a?b=1&c=2.');
  assert.equal(out, '<p>&lt;b&gt;hi&lt;/b&gt;<br>line two</p><p>see <a href="https://x.com/a?b=1&amp;c=2" rel="noopener nofollow" target="_blank">https://x.com/a?b=1&amp;c=2</a>.</p>');
  assert.equal(esc(`"'`), '&quot;&#39;');
});
