# What an iPhone's connect is sent (November 1, 2026)

The owner's iPhone took 10 to 30 seconds to connect to the laptop on a slow network, and under a second to forge. This
note records what each connect cost, where the time and bytes went, and what `reply-thread-records` and
`provider-mode-lists` (ADR-0028, November 1 amendment) changed.

## How it was measured

A throwaway client paired with each host the way the iPhone does, through Tailscale Serve on port 8443, and sent the
iPhone's own hello, `accepts` and all. It timed each phase, then counted what one connect was sent over eight seconds:
hello, then `observe` with no thread open, as the phone sends when it opens on Threads; and the same with a `shell` read,
which the phone makes when it has deliveries to check. Each pairing was removed when its run ended. Nothing was logged
on either host.

The after column could not come from the installed apps, which run the old listener. So the laptop's and forge's hello
shells were captured, kept on the laptop, and served through this branch's listener by a local test that is not committed
(the shells hold the owner's thread titles). The listener sent one thread change after hello and after the read, as a
running thread would. Its before matched the installed laptop's within 1%: hello 2,768 KB against 2,785 KB, the first push
1,742 KB against 1,759 KB.

## Where the time went

| Phase | Laptop | Forge |
|---|---|---|
| Tailscale path from the phone | direct, 29 ms ping | direct, 11 ms ping |
| `/v1/health` through Serve | 27-57 ms | 31-36 ms |
| `/v1/session` | 5 ms | 23-26 ms |
| Socket open | 5 ms | 6-7 ms |
| Hello answered | 79 ms | 33-47 ms |

None of this explains seconds. The bytes do: the laptop holds 632 threads and a catalog of 942 models, 846 of them
Devin's, against forge's 67 threads and 48 models, and phones are sent no compressed messages.

## What a connect is sent

Installed apps, before this change (eight seconds per connect, three and two runs):

| | Laptop | Forge |
|---|---|---|
| Hello | 2,785 KB | 228 KB |
| First shell push | 1,759 KB (every thread record again) | 212 KB |
| Connect | 4,820-5,658 KB | 228-782 KB |
| Connect with a `shell` read | 8,338-9,178 KB | 440-995 KB |

Replayed through this branch's listener, the same shells, before and after the phone accepts the two features:

| | Laptop before | Laptop after | Forge before | Forge after |
|---|---|---|---|---|
| Hello | 2,768 KB | 1,978 KB | 228 KB | 228 KB |
| First shell push | 1,742 KB | 279 KB | 212 KB | 84 KB |
| Connect | 4,510 KB | 2,257 KB | 440 KB | 312 KB |
| Connect with a `shell` read | 7,994 KB | 4,277 KB | 863 KB | 608 KB |
| Connect, if it were compressed | 528 KB | 321 KB | 86 KB | 66 KB |

On the laptop a connect is half what it was. Hello is 790 KB smaller because Devin's modes go once rather than 846
times; the first push no longer lists every record, because hello's are its base. Forge's catalog has no shared modes
worth naming, so its hello is unchanged.

## What is left

- Hello still lists every thread record: 1.48 MB of the laptop's 1,978 KB, 584 of the 632 threads settled.
- Every shell push to a phone carries the whole state but the threads, about 280 KB on the laptop, most of it Watcher's
  page, every one to three seconds while threads run.
- A `shell` read's answer lists every record, as a hello does.
- Compression would cut what is left about seven times; phones are left out of it until it is checked on a device
  (ADR-0025, October 18 amendment).
