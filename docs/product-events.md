# Product events

Sotto sends its developers a small record of how it is used, called product events, unless you turn them off. This page lists everything they can say. The code that holds them to this list is [`src/main/productEvents/schema.ts`](../src/main/productEvents/schema.ts), and the decision is [ADR-0179](adr/0179-sotto-sends-product-events-unless-turned-off.md).

Nothing goes until you press a button on a one-time notice, and no ID is made before that. **Escape** puts the notice off until the next start. **Reset settings** asks again.

## What links events to you

Each event carries a random ID for this install, and Sotto also sends hashed IDs of your Claude and OpenAI accounts. Hashed is not anonymous: those IDs link your computers to one person.

The hashes are SHA-256 with a prefix only Sotto uses, so they match no other app's hash of the same ID. Someone who already holds your account ID, your provider for one, can work out the same hash.

- Your Claude account ID is `accountUuid` in `.claude.json`, which holds no tokens.
- Your OpenAI account ID is the `user_id` claim of `id_token` in Codex's `auth.json`. That file also holds live sign-in tokens. Sotto takes only `id_token` from it, decodes only its middle part, and only the claim leaves that function, hashed. Sotto copies, keeps and logs no credential.

## Sent with every event

| Field | What it holds |
|---|---|
| `uuid` | A random ID for this one event, which stops a retry being counted twice |
| `event` | The event's name, from the list below |
| `timestamp` | When it happened |
| `distinct_id` | The hash of the random ID made for this install |
| `appVersion` | Sotto's version |
| `channel` | `stable` or `owl` |
| `surface` | `desktop` or `host` |
| `platform` | `windows`, `macos`, `linux` or `other` |
| `arch` | `x64`, `arm64` or `other` |
| `$process_person_profile` | Always `false`: no PostHog person profile |
| `$geoip_disable` | Always `true`: no location lookup |

## The events

### `install.owner_observed`

Once per start, for each account signed in. It links one person's computers.

| Field | What it holds |
|---|---|
| `ownerSource` | `claude` or `openai` |
| `ownerId` | The account ID's hash, 64 hexadecimal characters |

### `app.started`

Once per start, or when you answer the notice if that comes later. It counts active installs by version and system.

| Field | What it holds |
|---|---|
| `pairedHosts` | How many hosts this desktop has saved. Always 0 on a host |

### `thread.started`

A thread Sotto made begins its first turn. A draft nobody sent and a session found in a provider's history are not counted. It shows which providers and ways of starting get used.

| Field | What it holds |
|---|---|
| `provider` | Which provider ran it, such as `claude` or `codex` |
| `model` | The model's name, only if it is on Sotto's list of providers' public models. Any other model, such as one on your own server, sends no name |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` or `ultracode` |
| `permissionMode` | The thread's permission mode |
| `inWorktree` | Whether it runs in a worktree of its own |
| `startedBy` | `user`, `watcher`, `delegation`, `council`, `swarm` or `other` |

### `turn.completed`

A turn Sotto saw start ends. History read back, a turn already running when Sotto started and a turn whose outcome was lost are not counted, so it errs toward counting too few. It shows reliability, speed and token use by provider and model.

| Field | What it holds |
|---|---|
| `provider`, `model`, `effort`, `permissionMode`, `startedBy` | As in `thread.started` |
| `speed` | `standard`, `fast` or `ultrafast` |
| `result` | `completed`, `failed` or `stopped` |
| `durationMs` | How long the turn took |
| `inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningTokens` | The turn's token counts |
| `childInputTokens`, `childOutputTokens` | The token counts of its child agents, never their output |

### `feature.used`

You start a feature from a fixed list. A press on anything else sends nothing. It goes at most once a day per feature while Sotto runs, and once more after a start, so it says whether this install used a feature rather than how often. It shows what gets used and what to fix or remove.

| Field | What it holds |
|---|---|
| `feature` | `council`, `watcher`, `swarm`, `delegation`, `browser`, `test-iphone`, `terminal`, `files`, `changes`, `usage`, `add-host`, `add-phone` or `3d-model` |

## Never sent

- Prompts, replies, dictated words and audio
- File contents, file names and paths
- Project, repo and branch names
- Thread IDs and titles, provider session IDs
- Tool input and output, raw provider events
- Child-agent output: only their token counts
- Keys, tokens, emails, user names and machine names
- Names of the apps you dictate into
- Any model not on the list of providers' public models
- Error messages

Each event has a fixed list of fields. An event with anything else on it is dropped before it can leave, and the Worker checks it again against the same list.

## Where it goes

Sotto sends batches of at most 20 events, about every 30 seconds, to `events.saysotto.com`, a Cloudflare Worker of Sotto's own. The Worker keeps a copy for 90 days and forwards events to PostHog, which is where they are read. An hourly sweep removes each copy before it is 90 days old. Cloudflare's own database backups, which cannot be turned off, can restore a removed copy for a further 7 to 30 days.

Your IP address reaches Cloudflare with each request. The Worker does not store it or pass it on. PostHog person profiles and location lookup are off, and no PostHog code runs in Sotto.

A batch that cannot be sent is tried again for at most 30 minutes, then dropped. Sending never holds up a thread, and failing to send is never shown. The iPhone app sends no product events.

## Turning it off

- **Send product events** in **Settings → Application**. Off sends nothing more, drops what is waiting, stops a send in flight and deletes the install ID.
- `SOTTO_TELEMETRY_ENABLED=false` or `DO_NOT_TRACK=1` in the environment, on this computer or a host. It does the same and outranks the switch, which then shows as off and says why.
- A remote host follows the desktop. It makes no ID and sends nothing until a connected desktop says the switch is on and the notice was answered, and any connected desktop saying off wins. With no desktop connected it holds at most 1,000 events in memory, never on disk, and a host that never hears from a desktop never sends.

Development and test builds have no endpoint, so they send nothing.
