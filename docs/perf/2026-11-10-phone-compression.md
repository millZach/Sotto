# Compressing what a phone is sent - November 10, 2026

The November 10 audit (`docs/perf/2026-11-10-performance-and-data-audit.md`, finding 4) found that the iPhone is sent
nothing compressed, though its URLSession offers `permessage-deflate` by itself and Tailscale Serve passes the offer on.
On forge's own host, each frame compressed alone as a desktop's is, the hello would go from 237 KB to 64 KB and a
thread's step window from 93 KB to 22 KB. Zach chose to check on his own iPhone, against a second host on forge, before
any phone was compressed (#2394). The check passed, and every listener that serves phones now compresses for a phone that
offers it. This note says what changed, what the check on the iPhone showed, and what the probe measured before and after.

## What changed

- Every listener that serves phones answers a phone's offer as it answers a desktop's and sends that phone's messages
  exactly as a desktop's: the desktop's own phone listener and a headless host's tailnet listener. The same answer, the
  1 KiB threshold, level 6, the 64 KiB limit above which a message is compressed on the thread pool, send order, the
  16 MiB caps and the unread-output cap, all of them `SocketFrames`' own. Phone access turns it on for its listener
  (`compressPhones` in `src/main/phones/phoneAccess.ts`). A phone that offers nothing is never sent a compressed frame,
  and the local apps listener, on loopback, answers no offer.
- `SOTTO_HOST_COMPRESS_PHONES=0` in the environment a headless host or the desktop starts with turns it off, without a
  release, should a phone misread compressed messages. It is read once at start and not handed to the processes the host
  starts; any other value, or none, leaves phones compressed. A headless host started with it prints
  `[Sotto] phone-compression-off`. `docs/guide.md` says where to set it.
- `scripts/perf-bench/phone-wire-probe.mjs --offer-deflate` offers the extension bare, as the iPhone does, inflates what
  comes compressed, and reports what the host answered (`negotiated`, null for nothing) and each message's bytes on the
  wire (`wireBytes`) beside its size inflated (`bytes`) and the estimate (`deflatedBytes`).
- `tests/perf/phoneWireProbe.perf.test.ts` runs that probe against a host at forge's size, before and after.

What the host answers a phone, and why it is the desktop's answer, is in `docs/host-protocol.md` under Compression,
"Phones": RFC 7692 lets a server add `server_no_context_takeover` unasked (section 7.1.1.1) and requires a client to
support `client_no_context_takeover` in an answer (section 7.1.1.2), and the host needs the second to read each message a
phone compresses with no zlib state kept for the connection.

## The check on a real iPhone

On November 10 a host built from this change ran on forge with phone compression on (then still a switch,
`SOTTO_HOST_COMPRESS_PHONES=1`), on its own data folder and its own tailnet port, and Zach paired his iPhone with it.

- The probe, offering the extension as the iPhone does, was answered
  `permessage-deflate; server_no_context_takeover; client_no_context_takeover`. A hello of 19,529 bytes went as 3,030.
- The iPhone paired, showed the computer's page and its Threads list, and connected again after the app had been in the
  background. The kernel counted 3,372 bytes sent on its first connection in all, where the hello alone is 19,529
  uncompressed.
- Zach started a thread from the iPhone and had a reply of about 95 KB streamed to it. Opened again once it finished,
  the thread came whole: a `detail` of 94,675 bytes went as 34,671 on the wire, compressed on the thread pool because it
  is over 64 KiB. It showed.
- One fault turned up that is not compression's. Opening that thread while the reply was still streaming crashed the app.
  The host was started again with the switch off, the probe confirmed nothing was compressed, Zach did the same again, and
  the app crashed the same way. It is #2440.

The test host started with no threads of its own, so its hello was small; the hello under 70 KB that #2394 asks of forge's
real host is the audit's estimate of 64 KB, which the probe below shows is what a host sends.

## What the probe measured

A host at forge's size: the host-sized fixture the transfer benchmark uses (`ownerScalePipeline` with `host`, as
`hostSocketScale` builds it: 250 threads, Watcher's record with a paired desktop's 925 requests, the delivery ledgers and
skill lists forge's host holds), on the machine's own clock. One thread works: its reply streams twenty chunks a second
and its token usage moves twice a second, as Claude's adapter reports it, which is what a phone is pushed a thread list
for. Two listeners shaped like a headless host's tailnet listener serve it: before, one that compresses for no phone, as
every host did until now and as one started with `SOTTO_HOST_COMPRESS_PHONES=0` does; after, one that compresses for
phones, as every phone listener does now. Two probes ran at once, one on each, both offering the extension bare as the
iPhone does, so both were sent the same pushes: 60 seconds on the Threads list, then the working thread opened, then 60
seconds on it. forge, Intel Core i5-14400F, Node v24.22.1, other agents' work running beside it.

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/phoneWireProbe.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

| What the phone was sent | Before | After | Ratio | forge's host, the audit: as sent, and estimated compressed |
|---|---:|---:|---:|---:|
| What the host answered the offer | nothing | `permessage-deflate; server_no_context_takeover; client_no_context_takeover` | | |
| The hello | 476,335 bytes | 58,675 bytes | 8.1 | 237 KB, 64 KB |
| The thread opened: its step window (`detail`) | 32,247 bytes | 3,220 bytes | 10.0 | 93 KB, 22 KB |
| The thread opened: the answer and 3 seconds after it, 6 thread list pushes among it | 1,242,332 bytes | 307,624 bytes | 4.0 | |
| A minute on the Threads list: 112 thread list pushes | 22.30 MB | 5.39 MB | 4.1 | 3.77 MB in 18 pushes, not estimated |
| A minute on the working thread: 112 thread list pushes and about 1,120 updates to the reply | 22.61 MB | 5.70 MB | 4.0 | 6.76 MB, 1.97 MB |

Bytes after are the message payloads as they came over the socket; before, nothing was compressed, so they are the JSON.
The probe's estimate of each message compressed was within four bytes a message of what the host sent after (58,679
against 58,675 for the hello), since the host compresses as the estimate does and RFC 7692 drops a four-byte tail. That
makes the audit's estimates from forge's real host what it will send now: the hello about 64 KB, a step window about
22 KB, a minute on a working thread about 1.97 MB.

Reading the table:

- The thread list pushes are what matter most, and they compress about four times here, about 199,100 bytes to about 48,200
  each, as forge's do to a desktop (210,659 to 60,270, 3.5 times). Each is over 64 KiB, so each is compressed on the
  thread pool. The fixture pushes about twice a second, because its usage moves twice a second; forge pushed a phone 32
  times in a minute on a working thread, so per minute forge's numbers are smaller, and the ratio is the measure here.
- The hello and the thread's detail compress better here than on forge, 8 and 10 times against 3.7 and 4.1: the
  fixture's thread records and messages are generated and repeat more than real ones. Read forge's estimates for those.
- The updates to the reply, 15 to 273 bytes each, are under 1 KiB and go as they are, as the extension allows.
- The fixes for the audit's finding 2 (#2392, #2393) make the thread list pushes far smaller; what compression saves then is
  mostly each hello and each thread opened.

## Android

The Android client (ADR-0059, proposed and not shipped) connects with OkHttp 4.12.0. Its source
(`okhttp3/internal/ws/RealWebSocket.kt`, `WebSocketExtensions.kt`, `MessageDeflater.kt`, `MessageInflater.kt`,
`WebSocketReader.kt` at `parent-4.12.0`) offers bare `permessage-deflate` in every upgrade and refuses a caller's own
extension header. It reads the answer's `client_no_context_takeover` and `server_no_context_takeover`, resets its inflater
before each compressed message when the answer has the second, resets its deflater before each message it compresses when
it has the first, compresses only messages of 1 KiB or more, and reads a compressed message whole or in fragments, RSV1
on the first frame. It fails the socket with close code 1010 only for an answer it does not understand: an unknown
extension or parameter, any `client_max_window_bits`, or a `server_max_window_bits` outside 8 to 15. The host's answer has
none of them.

OkHttp itself was then run against the host's own listener, on forge under Java 25 with the 4.12.0 jar the Android build
names (`tests/integration/socketOkHttpInterop.test.ts`, which runs `tests/fixtures/OkHttpPhone.java`). It offered the
extension unasked and took the host's answer. It read a compressed hello and a compressed thread of over 64 KiB, each
with the same hash as the text the host sent. It then staged two photos of 300 KB on one connection, each a compressed
message of about 400 KB of base64, and the host inflated both whole and kept bytes with the hashes OkHttp sent. The
check fails when the listener does not compress for phones. It needs a Java and three jars the repository does not
carry, so it is skipped unless it is told where they are:

```sh
SOTTO_OKHTTP_CLASSPATH='<folder of okhttp-4.12.0.jar, okio-jvm-3.6.0.jar and kotlin-stdlib-1.9.10.jar>/*' \
  npx vitest run tests/integration/socketOkHttpInterop.test.ts --maxWorkers=1
```

That is OkHttp on a desktop Java, not the app on an Android device, which no one has run against a compressing host. If
it misbehaves there, `SOTTO_HOST_COMPRESS_PHONES=0` turns compression off on the host or desktop it reaches until a fix
ships.

## What was not checked

- What the iPhone sends. Its messages in the check were small (its hello is about 660 bytes), so whether URLSession
  compresses what it sends, and keeps no context between those messages as `client_no_context_takeover` asks, was not
  seen. A photo is the one large message an iPhone sends. A phone that compressed with context kept would have its second
  compressed message on a connection refused, and the host would close that connection. Sending two photos in one thread
  from the iPhone, to a computer that compresses, would show it. The host's side of it is held by a test: a phone-shaped
  peer sends two photos compressed on one connection and the host reads both (`tests/integration/socketCompression.test.ts`).
- The iPhone journeys in CI run the app against its own fixture rather than a host, so they do not exercise compression.
- Android on a device, above.
- The host-sized guard (`tests/perf/hostPushSizeBudget.perf.test.ts`) counts a push's JSON, not its bytes on the wire,
  and its phone offers nothing, so its phone budget is unchanged.

## Take it again

The bench above, with `SOTTO_PROBE_SECONDS` for a shorter stay on each screen. Against a running host on this machine,
the probe reports both columns at once, the estimate and the bytes on the wire:

```sh
node scripts/perf-bench/phone-wire-probe.mjs --data ~/.sotto --offer-deflate --list-seconds 60 --thread-seconds 60
```
