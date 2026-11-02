# Sotto's product event endpoint

A Cloudflare Worker that takes `POST /batch` from Sotto's sender, checks each event against the app's own schema, keeps the rebuilt event in D1 for 90 days, and forwards it to PostHog once it has a key (ADR-0179). It stores no IP address or header, keeps Cloudflare's logs off, and logs nothing.

It is not packaged with the app and is deployed by hand. It bundles `src/main/productEvents/schema.ts` and the public model list, so it needs this repository's `npm ci` before it builds, and there is no second list to keep level. Its tests are `tests/unit/workers/`, which run the real `schema.sql` over `node:sqlite`.

An hourly sweep removes each event before it is 90 days old, and tries again whatever PostHog did not take. Cloudflare's own D1 backups, which cannot be turned off, can restore a removed row for a further 7 days on the Free plan and 30 on a paid one.

## Try it on this computer

No account is needed, and nothing leaves the computer.

```sh
npx wrangler@4 d1 execute sotto-product-events --local --file schema.sql
npx wrangler@4 dev --port 8791 --ip 127.0.0.1
SOTTO_PRODUCT_EVENTS_ENDPOINT=http://127.0.0.1:8791   # in the environment of whatever sends
npx wrangler@4 d1 execute sotto-product-events --local --command "SELECT event, body FROM product_events"
```

## Deploy

With `CLOUDFLARE_API_TOKEN` set in the environment, never in a file in this repository:

```sh
npx wrangler@4 d1 create sotto-product-events       # put the database_id it prints in wrangler.jsonc
npx wrangler@4 d1 execute sotto-product-events --remote --file schema.sql
npx wrangler@4 deploy
```

**Do not set `POSTHOG_KEY` until the release with the notice is out.** Without it, events stop at the copy in D1. Setting it later sends only what arrives after that: a row kept before there was a key is never forwarded. When that release ships:

```sh
npx wrangler@4 secret put POSTHOG_KEY               # a project's capture key; it is not printed or kept here
```

`POSTHOG_HOST` defaults to PostHog's US region. For an EU project, set it to `https://eu.i.posthog.com` in `wrangler.jsonc` under `vars`. In PostHog's project settings, also turn on discarding client IP data.

When the app's fields change, deploy this Worker before the release that sends them; until then it refuses them. A new public model is the exception: it only loses the model's name.

Requests are limited to 120 a minute per Cloudflare location, counted together because the Worker reads no address. A hostile sender can use that up for real senders in its location, who get 429, wait and try again without losing anything for 30 minutes. If real use nears the limit, raise it.
