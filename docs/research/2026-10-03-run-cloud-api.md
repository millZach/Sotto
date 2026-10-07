# run.cloud's iOS simulator API, as raw HTTP

Read October 3, 2026, for the cloud iPhone adapter (ADR-0047). Sources:

- run.cloud's docs: `docs.run.cloud/llms.txt` and the 36 pages it lists.
- The published `@run-cloud/sdk@0.38.1` npm package. It is MIT-licensed and ships unminified `dist/index.js` and `index.d.ts`. Its source repository is private.

The docs say to use the SDK rather than its HTTP calls. Raw REST is documented only for interactions, screenshots, the accessibility tree, open URL and logs. Routes marked **[SDK]** come from the package and may change. No authenticated call was made.

## Auth and account

- Base URL `https://api.run.cloud`. Every call sends `Authorization: Bearer rc_live_…`, and JSON bodies are `application/json`.
- Keys are named API keys made in the run.cloud dashboard.
- `GET /run-cloud/account` checks a key. **[SDK]**
- `GET /run-cloud/usage?orgId=` returns `items[{org_id, meter, seconds}]`. **[SDK]**
- 408, 429 and 5xx are worth retrying. No rate limit is documented.
- An organisation's unpaid usage is capped at $5 without a card and $500 with one. Past that, new sessions are blocked and active ones close.

## Uploading a simulator build **[SDK]**

1. `POST /run-cloud/assets/uploads` with `{filename, name?, contentType, byteSize, uploadBatchId, uploadRunId, checksum: {algorithm: "md5", value}}`.
   - The answer is `{reused?, asset?, upload?: {url, headers, finalizeUrl}}`. If `reused` is true, or there is no `upload`, use `asset`.
2. `PUT upload.url` with the raw bytes and exactly `upload.headers`. Send no Authorization header.
3. `POST {finalizeUrl}` (Bearer) with `{checksum, startedAt, durationMs, retries}`. The answer is `{asset}`.

Other routes:

- `POST /run-cloud/assets` is a buffered multipart upload (fields `name` and `file`).
- `DELETE /run-cloud/assets/{id}` returns `{deleted}`.

An asset is `{id, name, filename, contentType, byteSize, createdAt, …}`. Accepted builds are `.zip`, `.tar.gz`, `.app` and `.ipa`, built for the simulator. The size limit is not documented. An uploaded asset is kept until it is deleted.

## Sessions **[SDK]**

- **Create:** `POST /run-cloud/ios`, with an optional `Idempotency-Key`. The body is `{model?: "iphone"|"ipad", displayName?, tags?, installAssets?: [assetId], inactivityTimeout?: "60s"|"3m"|"1h"|"none", hardTimeout?: "10m"|"1h", codec?: "auto"|"mjpeg"|"webrtc"}`.
  - There is no OS-version field.
  - It waits for capacity, then answers `status: "active"`. With no capacity it fails with 503 `simulator_capacity_unavailable`, which is safe to retry.
  - The answer is `{id, status: "active"|"released"|"failed", url, device, model, osVersion, runtime, inactivityTimeoutSeconds, createdAt, releasedAt, expiresAt, …}`.
- **Get:** `GET /run-cloud/ios/{id}`.
- **List:** `GET /run-cloud/ios?tag=k:v`.
- **Release:** `DELETE /run-cloud/ios/{id}`. It charges the final started minute.
- **Install into a running session:** `POST /run-cloud/ios/{id}/install {assetId}`. Assets passed in `installAssets` are installed and launched at create.
- **Keep alive:** `POST /run-cloud/ios/{id}/activity {}`.

## Interactions (documented)

`POST /run-cloud/ios/{id}/interactions` takes `{requestId, timeoutMs?, action, …}`.

- `requestId` matches `/^[A-Za-z0-9._:-]{1,128}$/`.
- `timeoutMs` is 100 to 60,000, default 15,000.
- Coordinates are normalised 0 to 1 from the top-left, in the current orientation.

Actions:

- `tap {x, y}`
- `swipe {from: {x, y}, to: {x, y}, durationMs?}`
- `gesture {steps}`
- `typeText {text}`: 1 to 10,000 US-ASCII characters, plus tab and line feed
- `pressKey {key, modifiers?}`: for example `enter`, `escape`, `backspace`, `arrowUp`
- `pressButton {button}`: `home`, `appSwitcher`, `power`, `volumeUp`, `volumeDown`, `sideButton`, `actionButton`
- `rotate {orientation}`
- `scroll {deltaX, deltaY}`
- `reload`

Success is `{ok: true, status: "completed", …}`, which confirms dispatch, not that the app rendered. Failure is `{ok: false, status, error: {code, message, retryable}}`.

Other routes:

- `POST /run-cloud/ios/{id}/open-url {url}` opens a link. `about:`, `data:`, `file:` and `javascript:` are refused.
- `GET /run-cloud/ios/{id}/screenshot` returns a PNG.
- `GET /run-cloud/ios/{id}/accessibility` returns `{schemaVersion: 1, screen: {width, height, unit: "points"}, nodeCount, truncated, roots: [node]}`.
  - A node is `{id, role, label, value, identifier, bounds: {x, y, width, height} | null, states, children}`.
  - There are at most 500 nodes. Secure values are null.
  - To tap a node, divide its centre by the screen size.

## Viewer

- The session's `url` is its signed viewer. It is a bearer secret and ends with the session. There is no separate mint route.
- Adding `embed=1` gives the embedded form.
- A human's pointer, touch, wheel and keyboard input in it count as activity. Watching alone does not.
- An iframe parent receives `postMessage` status (`streaming`, `appLaunched`, `session-ended`).
- A top-level page gets none of those, so Sotto polls `GET /run-cloud/ios/{id}` instead.
- Frame and CSP rules are not documented. Loading the viewer in an Electron view is not yet proven.

## Errors

- Codes include `invalid_interaction`, `active_session_not_found` (404), `simulator_capacity_unavailable` (503), `unsupported_action`, `interaction_timeout`, `simulator_gone` and `invalid_url`.
- Other errors may be `{detail}`, `{error}` or `{message}`, or an HTML page at the edge.
