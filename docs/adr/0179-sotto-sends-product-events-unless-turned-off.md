# Sotto sends product events unless they are turned off

## Status

Accepted November 2, 2026, at Zach's ask: "add anonymous analytics like T3 code has. Use their source code as reference and make it on my default in application tab of settings". He was told that hashed logins can still identify a person, and chose them. **Number provisional until merge** (docs/agents/domain.md).

This amends the promise in `AGENTS.md`, the README and ADR-0017 that Sotto adds no analytics. Crash upload stays out. Until a release carries the notice and the built-in endpoint, the README's words stay true, because no build can send: the part of this decision that names the endpoint, the notice, the README, the guide, setup's and Help's lines ships in one pull request and one release.

## Context

Sotto cannot tell which providers, models and features get used, or how often a turn fails, except by asking. T3 Code answers the same question with product events sent from its server to an endpoint of its own, and its source is MIT. Sotto's brief says nothing leaves the computer except what a feature the user uses needs, so this is a change to the brief and not only a feature.

## Decision

1. **What it is called.** A **product event**, in `CONTEXT.md`. "Usage" already names a page and "anonymous" would be untrue.
2. **On by default, and nothing before an answer.** The switch **Send product events** in Settings > Application is on by default. Nothing is sent, nothing is kept and no ID is made until the user presses a button on a one-time notice, a corner card. Escape puts the notice off until the next start. Reset settings asks again, and until it is answered sending stops, what waits is dropped and the install ID is deleted.
3. **Off means off.** Off sends nothing more, drops what is waiting, aborts a send in flight and deletes the install ID. `SOTTO_TELEMETRY_ENABLED=false` or `DO_NOT_TRACK=1` in the environment does the same and outranks the switch.
4. **Every field is on a list.** Each event has a strict schema (`src/main/productEvents/schema.ts`), so an unknown field stops the event. Every string is a closed list or a fixed shape, and a model name goes only when it has a published price in `usageRates.ts`, which is Sotto's reviewed list of providers' public models. A test fails when a forbidden field or a free string gets through.
5. **The events.** Zach chose five from the seven proposed and left out dictation and permission answers.

   | Event | When | Properties |
   |---|---|---|
   | `install.owner_observed` | Once per start, per signed-in account | `ownerSource`, `ownerId` |
   | `app.started` | Once per start | `pairedHosts` |
   | `thread.started` | A new thread starts | `provider`, `model`, `effort`, `permissionMode`, `inWorktree`, `startedBy` |
   | `turn.completed` | A turn ends | `provider`, `model`, `effort`, `speed`, `permissionMode`, `startedBy`, `result`, `durationMs`, token counts, child-agent token counts |
   | `feature.used` | A feature starts, from a fixed list | `feature` |

   Every event also carries `uuid`, `timestamp`, `distinct_id`, `appVersion`, `channel`, `surface`, `platform`, `arch`, `$process_person_profile: false` and `$geoip_disable: true`.

   Never sent: prompts, replies, dictated words or audio, file contents, file names or paths, project, repo or branch names, thread IDs or titles, provider session IDs, tool input or output, raw provider events, child-agent output, keys, tokens, emails, user or machine names, app names, error messages, and any model not on the list.
6. **Who an event is from.** `distinct_id` is the hash of a random ID made for this install. T3 prefers the Codex account because its older charts depend on it, and that ID is shared across a Codex Team; Sotto has no such history. Accounts are a separate fact, `install.owner_observed`, so devices link to one person when reports are read. The hashes are SHA-256 with a prefix only Sotto uses, so they match no other app's hash of the same ID. This is not anonymous, and the words say so: "Hashed is not anonymous: those IDs link your computers to one person." Someone who already holds an account ID, its provider for one, can work out the same hash.
7. **Reading the accounts.** Claude's is `accountUuid` in `.claude.json`, which holds no tokens. The OpenAI ID is the `user_id` claim of `id_token` in Codex's `auth.json`. That file also holds live sign-in tokens, so this is the one thing Sotto opens it for: only `id_token` is taken from it, only its middle part is decoded, and only the claim leaves that function, hashed. Zach chose this over hashing the email Codex reports, which a list of emails can reverse. Sotto still copies, keeps and logs no credential. The read happens once per start, off the update path, and only while the switch is on.
8. **Where it goes.** Batches go to Sotto's own endpoint, a Cloudflare Worker (`workers/product-events/`), which checks each event against the app's own schema, keeps the rebuilt event in D1 for 90 days and forwards it to PostHog. D1 over object storage because each event's `uuid` as its key stops a retry's second copy, and no payment card is needed to start. An hourly sweep removes each row before it is 90 days old; Cloudflare's own D1 backups, which cannot be turned off, can restore a removed row for a further 7 days on the Free plan and 30 on a paid one, and the docs page says so. The client holds no PostHog key, and without one the Worker forwards nothing; a row kept before there was a key is never forwarded. Only what a request newly stored goes to PostHog, and the sweep tries again what PostHog did not take. The address is `events.saysotto.com`, Zach's pick, which moved the domain's DNS from Porkbun to Cloudflare, since Cloudflare runs a single subdomain only on its Enterprise plan. GitHub Pages and Porkbun's mail forwarding stay as they were, with Cloudflare's proxy off. Requests are limited per Cloudflare location rather than per address, because the Worker reads no address. Cloudflare sees the IP address of each request; the Worker neither stores it nor passes it on. PostHog person profiles and location lookup are off. There is no PostHog SDK anywhere.
9. **Who decides on a host.** A host follows the desktop. It makes no ID and sends nothing until a connected desktop says the switch is on and the notice was answered, and any connected desktop saying off wins. With no desktop connected it holds at most 1,000 events in memory, never on disk, and a host that never hears from a desktop never sends. The environment switch works on a host as well.
10. **It never slows Sotto.** `record` checks an event against its schema, pushes it and returns; nothing fires per streaming update. A timer sends one batch of at most 20 events every 30 seconds and is armed only while something waits. A failed send backs off from 2 seconds to 5 minutes, and a batch is dropped after 30 minutes of failing or at once when refused. At most 1,000 events wait, a batch being sent included, oldest dropped first. Sending is silent, and logs carry stable event names only. Each pull request that adds a call site measures its path before and after.
11. **Scope.** Desktop and host, on Stable and Owl. It is not an Owl feature. The iPhone comes later. T3's Connect, relay tracing and crash reports are left out.

## Consequences

- `README.md`, `docs/guide.md`, setup's "No Sotto account, no telemetry", Help's "No account with Sotto and no telemetry", and ADR-0017's "Sotto remains telemetry-free" all change in the pull request that ships the notice.
- The new host goes into the README's "Privacy and cost" section with it.
- A new event or field is a change to this ADR, the schema and the docs page together.
- A development or test build has no endpoint, so it counts as no install. `SOTTO_PRODUCT_EVENTS_ENDPOINT` names one for a test run, over HTTPS or to this computer only.
- The prototype Zach chose from is kept as the tag `prototype/product-events`: notice variant A, switch variant A.
