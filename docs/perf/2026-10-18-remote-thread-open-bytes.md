# Remote thread open bytes - October 18, 2026

Threads on the owner's forge host took 15 seconds and more to show their messages in the desktop. The link between
them is a tailnet connection that carried about 370 KB a second with a round trip of 105 ms. On a copy of the host's
real data, opening a thread sent one `detail` frame of 0.2 to 3.7 MB, most of it activity `output` and message `text`,
because a desktop is sent activity records whole (ADR-0025, October 3 amendment). At 370 KB a second that is 0.5 to
10.7 seconds per open, and the largest thread, a 3,704,010-byte detail, takes 10.65 seconds. Each open also sent two to
four `shell` pushes of about 130 KB each, some of them byte for byte the shell already sent to that desktop.

Raw deflate at level 6 shrank that data's details about 3.5 times (3,704,010 to 1,073,028 bytes, about 176 ms on the
laptop; 948,574 to 220,448) and its shells about 3.75 times (130 KB to 35 KB, about 5 ms).

## The change

The host socket speaks `permessage-deflate` (RFC 7692) with desktops, with no compression context kept between
messages ([ADR-0025, October 18 amendment](../adr/0025-headless-host-and-client-identity.md#october-18-amendment-a-desktops-socket-messages-are-compressed-and-a-repeated-shell-is-not-sent),
`docs/host-protocol.md` under Compression). Phones are not offered it yet.

## How it was measured

`tests/perf/remoteThreadOpenBytes.perf.test.ts` builds a thread's detail and a shell from a seeded generator, with a
vocabulary of a few hundred identifiers and hashes and numbers between them, so they compress about as the host's real
data did. It sends each through the listener's own framing, `SocketFrames`, with and without the extension, and counts
the bytes written. The uncompressed counts are the same on every run and are asserted exactly; the compressed counts
depend on the zlib Node carries, so the default run asserts only that each is under 1/2.5 of the uncompressed bytes.
Timings run only under `SOTTO_PERF_BENCH=1`: medians of 15 runs after 3 to warm up, Windows 11, Intel Core Ultra 9
275HX, Node v24.14.1, with other agents' work running beside it. Seconds are the bytes at the field link's 370 KB a
second.

## Before and after

| Frame | Uncompressed | Compressed (level 6) | Ratio | At 370 KB/s before | After |
| --- | ---: | ---: | ---: | ---: | ---: |
| `detail` of a 1,040-record thread | 3,609,598 bytes | 1,103,460 bytes | 3.27 | 9.76 s | 2.98 s |
| `shell` of a 300-thread host | 130,767 bytes | 28,902 bytes | 4.52 | 0.35 s | 0.08 s |

## Level 1 or level 6

| Level | Detail bytes | At 370 KB/s | Deflate on the loop | Shell bytes | Shell deflate |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1,311,988 | 3.55 s | 63 to 71 ms | 34,267 | 1.2 to 1.8 ms |
| 6 | 1,103,454 | 2.98 s | 167 to 237 ms | 28,902 | 3.4 to 4.0 ms |

Level 6 saves about 0.57 seconds of transfer per long detail on this link for about 110 to 170 ms more compression.
Either level done on the host's event loop would hold every other client's pushes and answers for that long, so the
choice was level 6 with large messages compressed on Node's thread pool. A message up to 64 KiB, about 2 ms at level
6, is compressed at once; a larger one goes to the pool, and the connection's later messages queue behind it so the
order on the wire is unchanged. Sending the 3.6 MB detail then holds the host's loop for 3 to 5 ms, the cost of turning
the string into bytes and queueing it, while the compression itself takes 180 to 200 ms on the pool. The desktop
inflates on its own loop: about 21 ms for that detail, against about 6 ms to parse the JSON it yields.

## Shells the desktop already has

Each open also sent two to four shells of about 130 KB, some with a state byte for byte the one just sent. The
listener no longer pushes a shell whose state matches the last one it pushed to that client while there are no events
to bring (`docs/host-protocol.md` under Pushes). A repeated shell now costs nothing on the link instead of about 35 KB
compressed or 130 KB before compression; `tests/integration/socketShellRepeats.test.ts` checks that a repeat is not
sent and that a change, an event or an answer that carried a shell is.
