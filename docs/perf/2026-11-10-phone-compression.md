# Compressing what a phone is sent, behind a switch until a real iPhone reads it - November 10, 2026

The November 10 audit (`docs/perf/2026-11-10-performance-and-data-audit.md`, finding 4) found that the iPhone is sent
nothing compressed, though its URLSession offers `permessage-deflate` by itself and Tailscale Serve passes the offer on.
On forge's own host, each frame compressed alone as a desktop's is, the hello would go from 237 KB to 64 KB and a
thread's step window from 93 KB to 22 KB. Zach chose to check on his own iPhone, against a second host on forge, before
any phone is compressed (#2394). This note says what is built for that check, what the check must show, and what the
probe measured against a test listener.

## What is built

- `compressPhones`, an option of the host's listener (`src/host/socketServer.ts`). On, a phone that offers the extension
  is answered and sent compressed messages as a desktop is: the same answer, the 1 KiB threshold, level 6, the 64 KiB
  limit above which a message is compressed on the thread pool, send order, the 16 MiB caps and the unread-output cap,
  all of them `SocketFrames`' own. Off, which is the default, nothing changes for any phone.
- A headless host turns it on for its tailnet listener when started with the environment variable
  `SOTTO_HOST_COMPRESS_PHONES=1`, read once at start and not handed to its providers' processes. It prints
  `[Sotto] phone-compression-on` when it took. No host Sotto starts sets it, and the desktop's own phone listener has no
  such switch.
- `scripts/perf-bench/phone-wire-probe.mjs --offer-deflate` offers the extension bare, as the iPhone does, inflates what
  comes compressed, and reports what the host answered (`negotiated`) and each message's bytes on the wire (`wireBytes`)
  beside its size inflated (`bytes`) and the estimate (`deflatedBytes`). Without the option it offers nothing, as before.
- `tests/perf/phoneWireProbe.perf.test.ts` runs that probe against a test listener with the switch off and on.

What the host answers a phone, and why it is the desktop's answer, is in `docs/host-protocol.md` under Compression,
"Phones, not yet": RFC 7692 lets a server add `server_no_context_takeover` unasked (section 7.1.1.1) and requires a
client to support `client_no_context_takeover` in an answer (section 7.1.1.2), and the host needs the second to read
each message a phone compresses with no zlib state kept for the connection.

## What the probe measured

Main at the owner's scale (`tests/fixtures/ownerScalePipeline.ts`: 250 threads, 40 on a remote host, Watcher's record,
172 models, every payload generated) behind two listeners on loopback: one with the administrative routes, which the
probe pairs through, and one shaped like a headless host's tailnet listener with no desktop recorded, which the probe
reaches as a phone, with `compressPhones` off and then on. The probe ran with `--offer-deflate`, five seconds on the
Threads list and five on an opened thread. forge, Intel Core i5-14400F, Node v24.22.1, other agents' work running beside
it.

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/phoneWireProbe.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

| The hello | Switch off | Switch on |
|---|---:|---:|
| What the host answered the offer | nothing | `permessage-deflate; server_no_context_takeover; client_no_context_takeover` |
| Its JSON | 282,671 bytes | 283,858 bytes |
| On the wire | 282,671 bytes | 13,113 bytes |
| The probe's estimate | 12,961 bytes | 13,117 bytes |

A second run, after `main` was merged in, gave the same JSON sizes, 13,109 bytes on the wire with the switch on, and
estimates of 12,956 and 13,113 bytes. Within a run the two halves are seconds apart on one main that keeps working, so
the hello grew by two thread records between them. The
hello is over 64 KiB, so with the switch on it was compressed on the thread pool and arrived as one frame, which the probe
inflated and read. The other messages in that run were under 1 KiB and went as they were, as the extension allows.

The estimate is the host's own deflate at level 6 with the four-byte tail RFC 7692 drops left on, so on a host with the
switch on the bytes on the wire are the estimate less four bytes for each compressed message. That makes the audit's
estimates from forge's real host the numbers to expect there: the hello 237 KB to about 64 KB, a step window 93 KB to
about 22 KB. The generated main compresses about 21 times, far better than real threads, whose words and command output
repeat much less; read its ratio as the generator's, not the host's. The thread the probe opened is the generator's first
idle thread and carries almost nothing, 162 bytes; a phone reading a message over 64 KiB is covered by the hello here and
by `tests/integration/socketCompression.test.ts`, whose phone reads a 2.2 MB thread compressed.

## What the check on the iPhone must show

Against a host on forge started from this branch with the switch on, its own data folder, and Serve on its own port, the
iPhone, paired with it once by its full address and port:

1. connects at all. URLSession must take the answer; if it refuses it, the iPhone cannot reach that host and says it can't
   reach it, and the switch stays off.
2. shows the host's Threads list and its computer page, which come in the hello. The hello must arrive compressed: the
   probe with `--offer-deflate` against the same host reports `negotiated` and the hello's `wireBytes`. The test host
   starts with no threads of its own, so its hello is smaller than forge's; the "under 70 KB" in #2394 is for forge's
   real host, once phones are compressed there.
3. reads one message over 64 KiB, which the host compresses on its thread pool. The hello is one when the host lists
   enough, and the probe says how big it is. If it is not, a reply of more than 64 KiB in the test thread is one once the
   thread is opened again, since an opened thread comes whole.
4. opens a thread and follows it while it works, its words arriving as they are written.
5. stays connected for a few minutes with the app open, and connects again after it goes to the background and back.

When it does, the change that turns phone compression on for everyone is a small one, with ADR-0025 and
`docs/host-protocol.md` amended again, and the probe run against forge's real host for the before and after. Android's
OkHttp offers the extension too, and is checked the same way before that change covers it.
