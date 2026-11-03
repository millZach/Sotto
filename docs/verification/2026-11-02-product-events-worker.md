# The product event Worker, live at events.saysotto.com

Part of #2048 (ADR-0179). The Worker is deployed with no PostHog key, and no Sotto build has an endpoint, so nothing reaches PostHog and no installed Sotto sends here.

## The domain move

`saysotto.com`'s nameservers moved from Porkbun to Cloudflare on November 2, 2026, at 21:37 UTC by the `.com` registry's RDAP record, because Cloudflare runs a single subdomain only on its Enterprise plan. Ten records were copied first, with the proxy off: four A records and `www` for GitHub Pages, two MX and one SPF TXT for Porkbun's mail forwarding, and two `_acme-challenge` TXT records. Cloudflare's assigned nameservers answered them all before the switch. Afterwards the site answers 200 and is still served by GitHub.

NOT VERIFIED: real mail through the forwarding. Its records are in place and Porkbun's guide supports this setup, but no message was sent.

## A real run

Sotto's own sender, bundled from this branch, sent through `SOTTO_PRODUCT_EVENTS_ENDPOINT=https://events.saysotto.com`, with fixture account files rather than anyone's real accounts:

- Before the notice, nothing queued.
- After it, one send stored these on the live D1 database: `app.started`, two `install.owner_observed`, `thread.started`, `turn.completed`.
- Refused by the sender, and on no row: `feature.used` with a `prompt` field, and `thread.started` with a private model name.

Sent straight to the live address with `curl`:

| Post | Answer |
|---|---|
| `app.started` with a `path` field | 400 |
| `feature: "secret-repo-name"` | 400 |
| Not JSON | 400 |
| `feature: "council"`, with `X-Forwarded-For` and a marked `User-Agent` | 204 |

The six rows were then read back from D1. None held the fake address, the user agent, the prompt, the private model, the repo name, the fixture's token, email or raw account IDs, or a path. Every row had `forward_due` 0. The row as stored:

```json
{
  "uuid": "c563ceb1-f643-4677-bad5-731c437f2350",
  "event": "turn.completed",
  "distinct_id": "d155b5e8022b5c09a51bd46afa4e910d4188eb429c1454750d4220d9877997ef",
  "timestamp": "2026-11-02T21:58:12.359Z",
  "properties": {
    "provider": "codex", "model": "gpt-6-sol", "effort": "high", "permissionMode": "approval-required", "startedBy": "user",
    "speed": "standard", "result": "completed", "durationMs": 48211, "inputTokens": 18204, "cachedInputTokens": 15360,
    "outputTokens": 912, "reasoningTokens": 240, "childInputTokens": 0, "childOutputTokens": 0,
    "appVersion": "0.1.43", "channel": "stable", "surface": "desktop", "platform": "linux", "arch": "x64",
    "$process_person_profile": false, "$geoip_disable": true
  }
}
```

The test rows were deleted afterwards, and the Worker lists no secrets, so it has no PostHog key.

## The rate limiter

220 quick posts of `{}` all got 400, because Cloudflare's counts catch up in the background. A sustained run of 80 posts every 7 seconds or so got 429 for 7 of the first 80, then 28 to 60 of each later 80, and a post after a quiet minute got 400 again. Those posts wrote nothing. So the limit works and is approximate, as Cloudflare documents.

NOT VERIFIED: the hourly sweep on its cron, which first runs at 17 minutes past the hour. The same code ran in `wrangler dev` before the sweep's retry was added, and its behaviour is covered by `tests/unit/workers/`.
