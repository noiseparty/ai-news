# AI Dispatch

A hand-curated, newsletter-style AI newsfeed. Post a link and it's added with its
title, summary and image pulled from the page. You can add your own comment
("My take") and file it under a category:

**General AI · Models · Science · Methods · Workflows · Websites**

The front page shows one section per category (latest 5 each). `/c/<category>`
lists everything in that category, grouped by day.

Zero npm dependencies. Data lives in `data/items.json` and `data/subscribers.json`.

## Run

```sh
cp .env.example .env        # set ADMIN_TOKEN at least
npm start                   # http://127.0.0.1:8931
npm test
```

## Posting a link

1. **Admin page**: `/admin`, sign in with `ADMIN_TOKEN`. Paste a link, press
   *Fetch preview*, pick a category, add a comment if you want, and *Publish*. Every field
   is editable before publishing (useful for sites like X that hide their
   previews). Existing posts can be edited or deleted from the same page.
2. **Bookmarklet**: the admin page has a `+ AI Dispatch` link. Drag it to your
   bookmarks bar. Clicking it on any article opens the admin form with that link
   already filled in and previewed.
3. **Terminal**:
   ```sh
   npm run add -- https://example.com/article "My comment" --cat models
   # optional: --title "Manual title" (skips fetching the page)
   ```
   Posts through the API of whichever server `AI_NEWS_URL` points at, so it works
   against the live site too.
4. **API** (for scripts, n8n, iOS Shortcuts, etc.):
   ```
   POST /api/items
   Authorization: Bearer <ADMIN_TOKEN>
   Content-Type: application/json

   {"url": "...", "category": "models", "comment": "optional", "title": "optional"}
   ```
   Also `PATCH /api/items/:id`, `DELETE /api/items/:id`, `POST /api/preview {url}`.

## Subscribing

- **Email sign-up** on the page stores addresses in `data/subscribers.json`.
  Nothing is sent yet. The confirmation message says so and points people to RSS.
  Export the list at `/admin/subscribers.csv` when you hook up a mail provider.
- **RSS** works now: `/feed.xml` for everything, `/c/<category>/feed.xml` per category.
  Your comments are included in each feed entry.

## Config (env)

| Var | Default | |
|---|---|---|
| `ADMIN_TOKEN` | *(unset = admin disabled)* | Admin password / API bearer token |
| `BASE_URL` | from Host header | Public URL, used in RSS. `https://…` makes the cookie `Secure` |
| `PORT` / `HOST` | `8931` / `127.0.0.1` | |
| `SITE_TITLE`, `SITE_TAGLINE`, `SITE_AUTHOR` | | Branding |
| `SITE_TZ` | `Europe/Riga` | Day grouping and dates |
| `DATA_DIR` | `./data` | |

## Security notes

- The link fetcher refuses loopback and private addresses on every redirect hop,
  so it can't be used to probe services on the host.
- Browser sessions use an HMAC cookie (`HttpOnly`, `SameSite=Lax`). Writes also
  require an `X-Requested-With` header to block CSRF. Changing `ADMIN_TOKEN` logs
  out every session.
- Login and subscribe are rate limited per IP. Behind Caddy, the last
  `X-Forwarded-For` hop is used as the client IP.
