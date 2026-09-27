#!/usr/bin/env node
'use strict';

/**
 * Post a link from the terminal:
 *
 *   node bin/add.js <url> ["comment"] [--cat models] [--title "..."]
 *
 * Talks to the running server's API, so it works against localhost or the live
 * site alike. Needs AI_NEWS_URL (default http://127.0.0.1:8931) and ADMIN_TOKEN.
 */

const { CATEGORIES } = require('../lib/categories');

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cat' || a === '-c') out.category = argv[++i];
    else if (a === '--title' || a === '-t') out.title = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else out.positional.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [url, comment] = args.positional;
  if (args.help || !url) {
    console.log(`Usage: node bin/add.js <url> ["comment"] [--cat <category>] [--title "..."]\nCategories: ${CATEGORIES.map((c) => c.id).join(', ')}`);
    process.exit(args.help ? 0 : 1);
  }

  const base = (process.env.AI_NEWS_URL || 'http://127.0.0.1:8931').replace(/\/+$/, '');
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    console.error('Set ADMIN_TOKEN (same value the server uses).');
    process.exit(1);
  }

  const body = { url };
  if (comment) body.comment = comment;
  if (args.category) body.category = args.category;
  if (args.title) body.title = args.title;

  const res = await fetch(`${base}/api/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Failed (${res.status}): ${data.error || res.statusText}`);
    process.exit(1);
  }
  console.log(`Posted to ${data.category}: ${data.title}\n${base}/c/${data.category}#item-${data.id}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
