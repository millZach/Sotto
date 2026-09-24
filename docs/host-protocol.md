# Host protocol, version 1

This is every message a client and a host exchange: the desktop reaching a remote host through `SocketHostService`, and the planned iPhone client (#225) from its own Swift code. The schemas are in `src/shared/hostProtocol.ts`; the listener is `src/host/socketServer.ts`. Why the host works this way is ADR-0025.

Version 1 is frozen from the pull request that added detail deltas and the version check (#238, #239). A later host may add to it, and only in these ways:

- an optional field on a response or push, which a client may ignore;
- a new **host feature**, named in the `features` list of health, the listener file and the hello reply;
- a new push form, sent only to a client that asked for it by feature name in hello's `accepts`.

Nothing v1 carries is renamed, removed or given a new meaning. A change that needs one is version 2, with its own support window. `v` stays `1` on every message until then.

## Versions and features

Every host advertises two things beside `v`:

- `sottoVersion`: the Sotto release the host runs, such as `0.1.16`. It says which build answered; it is not a compatibility rule by itself.
- `features`: the host features it offers. This build offers two: `detail-delta`, and `git-refs` for the branch picker's request.

A client reads `/v1/health` before it opens a session, and uses a feature only when the host lists it. It never finds out by sending a request and reading the refusal. Feature names it does not know are ignored.

A host whose health carries no `features` predates the freeze, and one with another `v` speaks another protocol. The desktop sends such a host nothing more and says which side to bring up to date. For a host whose `sottoVersion` is older, or that advertises none: "This host is running a different version of Sotto. Nothing on the host was lost. Put the Sotto 0.1.16 host in its installation folder, press Stop host, then connect again.", naming the desktop's own version, because Connect starts whatever is installed. For a host Sotto did not start, "press Stop host" becomes "stop the host on that machine". For a host whose `sottoVersion` is newer: "This host is running a newer version of Sotto than this computer. Nothing on the host was lost. Update Sotto on this computer, then connect again." The Hosts page keeps Stop host beside the first sentence for a host Sotto started.

Between two v1 builds of different Sotto versions, the thread and command shapes inside the envelope can still differ. When a host of another version refuses a request as unreadable, or sends something the client cannot read, the desktop says the same sentence instead of "This request is not supported" or closing the socket.

"Capabilities" in the hello reply is a different thing: what this client may do on this host (`mayAnswer`), set by the host's policy records. It is not a feature list.

## HTTP

All on the host's loopback listener, reached through the SSH forward or private Tailscale HTTPS. Every response is JSON with `Cache-Control: no-store`. A request carrying an `Origin` other than a loopback page, or one the host was started to allow, is refused.

| Request | Body | Answer |
| --- | --- | --- |
| `GET /v1/health` | none | `{ v: 1, status: "ready", hostId, pid, port, sottoVersion, features }` |
| `POST /v1/pair` | `{ v: 1, code, name }` | `{ v: 1, hostId, clientId, token }`. The code is single use and lasts five minutes. |
| `POST /v1/session`, `Authorization: Bearer <token>` | none | `{ v: 1, hostId, clientId, session, expiresAt }`. A session lasts twelve hours. |
| `POST /v1/revoke`, `Authorization: Bearer <token>` | none | `{ v: 1, hostId, revoked }`. The client forgets itself. |
| `POST /v1/admin/pairing-code`, admin bearer | none | `{ v: 1, hostId, code, expiresAt }` |
| `POST /v1/admin/revoke-client`, admin bearer | `{ clientId }` | `{ v: 1, hostId, revoked }` |
| `POST /v1/admin/allow-answers`, `/v1/admin/deny-answers`, admin bearer | `{ clientId }` | `{ v: 1, hostId, ok: true }` |

The admin bearer is in the host's private `host-listener.json`, which holds the same fields as health (without `status`) plus `adminToken`. Only the launch script and the host's own command line use it. A refusal is `{ v: 1, error: { code, message } }` with status 401 for `unauthenticated`, 429 for `busy` and 400 otherwise. A request body is at most 8192 bytes.

## The socket

`GET /v1/socket` upgrades to a WebSocket (RFC 6455, version 13) with `Authorization: Bearer <session>`. Every message is one UTF-8 JSON text frame of at most 16 MiB. The host allows 32 clients, 100 requests a second and 32 unanswered requests per client, and closes a client that goes over.

### Requests

Each request is `{ v: 1, id, session, op, ... }`: `id` is the client's own (at most 512 characters) and comes back on the response, and `session` is the one the socket opened with. Requests are strict: a field the host does not know makes the request unreadable.

| `op` | Fields | Result |
| --- | --- | --- |
| `hello` | `afterSeq?`, `accepts?` | `{ hostId, clientId, shell, capabilities: { mayAnswer }, sottoVersion, features, events, latestSeq, hasMore }`. `accepts` lists the host features this client takes, from those the host advertised; `["detail-delta"]` asks for detail deltas. |
| `shell` | none | The shell: the published state without any thread's history, with this client's own selection. |
| `detail` | `threadId` | One thread's whole detail `{ threadId, revision, messages, activities?, earlierAvailable? }`, or `null`. |
| `events` | `afterSeq`, `threadId?` | `{ events, latestSeq, hasMore }`, at most 256 events after that sequence number. |
| `observe` | `threadIds` (at most 100) | `null`. Replaces this client's observed threads; the host pushes each one's detail. |
| `command` | `command` | The shell after the command. Only the commands and fields on the list in `src/host/remoteCommands.ts` are accepted. The request `id` is the command ID: sending the same one again replays the result for five minutes instead of acting twice. |
| `receipt` | `commandId` | `{ status: "pending" \| "completed" \| "unknown", error? }` for a command this client sent. |
| `preview` | `request` | One attachment preview, or `null`. |
| `git-refs` | `request` | A page of one thread's Git refs for the branch picker: `{ refs, isRepository, hasRemote, nextCursor, total }`, each ref `{ name, remote?, current, isDefault, worktreePath }`. `request` is `{ threadId, query?, cursor?, limit?, includeMatchingRemoteRefs?, refresh? }`. Only on a host that lists the `git-refs` feature; a client sends it to no other. |

A response is `{ v: 1, id, ok: true, result }` or `{ v: 1, id, ok: false, error: { code, message } }`. A request from this session that the host cannot read, such as one from a client of a newer Sotto version, is answered with `invalid_request` by its `id`; a message that is not JSON, or has no readable `v`, `id` and `session`, closes the socket.

### Pushes

A push has `event` in place of `id`. The host coalesces them the way the desktop's IPC does: the shell, and each thread's detail, go out at most once every 50 ms. A shell push carries the state as it is when it is sent; deltas waiting for one thread are folded into one where they can be and otherwise sent in order.

| `event` | Fields | Sent |
| --- | --- | --- |
| `shell` | `state`, `eventPage?` | When the shell changes. `eventPage` is `{ events, latestSeq, hasMore }` after this client's place in the event stream; `hasMore` means read the rest with `events`. |
| `detail` | `threadId`, `detail` | An observed thread's whole detail: on observing it, on selecting it, when the host cannot describe a change as a delta, and on every change to a client that did not accept `detail-delta`. |
| `detail-delta` | `threadId`, `delta` | What changed in an observed thread, to a client that accepted `detail-delta`. |
| `error` | `threadId?`, `error` | In place of a push that would not fit in one frame (`too_large`). `threadId` names the thread whose detail or delta it replaced. |

### Detail deltas

A delta is `{ threadId, baseRevision, revision, messageDeltas, activityDeltas }`, the same form the desktop's window gets over IPC (`AgentThreadDetailDelta` in `src/shared/agents.ts`, arithmetic in `src/shared/agentThreadDetail.ts`). A message delta is a whole message `{ message }`, or `{ id, appendText }` for text a streaming message grew by. An activity delta is a record as it now stands `{ record }`, or `{ id, removed: true }`.

A client applies a delta only when `baseRevision` is the revision it holds: appended text goes on the end of that message, a whole message replaces the one with its ID or goes last, a record replaces the one with its ID in place or goes last, and a removal drops it. It then holds `revision`. A delta whose `revision` is not newer than what it holds is already covered and is dropped. Any other delta means a push was missed: the client asks for the whole thread with `detail`, once however many deltas miss, and applies deltas again from the revision that returns.

When a thread is too large to send, its `error` push names it. A client does not ask for that thread again because a delta did not follow; observing it again, or its whole detail arriving, starts it over.

### Error codes

| Code | Means |
| --- | --- |
| `unauthenticated` | The session or token is not valid any more. Connect again or pair again. |
| `invalid_request` | The host cannot read or does not support the request. |
| `stale_request` | The request being answered has changed or been answered. |
| `forbidden` | This device may not do that; its permission policy or the host decides. |
| `unavailable` | The host could not complete the request. |
| `busy` | Too many pending requests. |
| `too_large` | The answer or push would not fit in one frame. Nothing on the host was lost. |

Every `message` is plain copy for the user. None is logged with a prompt, a transcript, a token or a pairing code.
