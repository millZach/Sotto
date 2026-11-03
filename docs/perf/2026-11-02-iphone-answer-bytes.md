# What an answer and a reply from an iPhone cost (November 2, 2026)

The owner reported replies and answers taking a very long time to go through, on and off. Asked, they said it was the
iPhone app, on home Wi-Fi, on threads on the laptop. This note records where the time went and what changed.

The laptop was running Owl 0.1.43-owl.20261102.1, built from `0c81acedf` on main at 04:17Z. It does not have #2002 or
#2020, the connect cuts, or anything merged after them. The iPhone's TestFlight build does, but those cuts need both sides.

## The computers are not the wait

| Check | Result |
|---|---|
| Laptop, `answer` turn records today (`turns.jsonl`) | p50 317 ms, p90 564 ms, worst 671 ms |
| Laptop, `send` turn records today | p50 848 ms, p90 1,456 ms, worst 3,907 ms |
| forge, `answer` turn records since November 1 | p50 110 ms, p90 182 ms, worst 247 ms |
| Laptop main's event loop: `/v1/health` on its listener, twice a second for 25 minutes | 2,968 probes, 6 over 50 ms, 1 over 200 ms, worst 533 ms |
| Hang recordings, which main writes after 5 s stopped | None since October 26 |
| Laptop to forge, `/v1/health` through Serve | 22 to 42 ms |

So whole-file saves, SQLite and Watcher's wake-ups are not holding sends here. Watcher woke 317 times today, at p50 706 ms,
and main stayed answering. Main does spend about a quarter of a core, but in pieces too small to feel in this window.

## The bytes are

Bytes to the phone come from the laptop's `tailscale status --json`, read once a second, beside the socket's lifetime from
`netstat` and the turn records' times.

| Time (UTC) | What happened | Sent to the phone |
|---|---|---|
| 17:23:16 | A connect | About 5.0 MB in one sample of about a second |
| 17:23:21 | One `answer`, 717 ms on the laptop | About 6.3 MB in the next sample |
| 17:25:12 | A connect | About 4.8 MB in one sample |
| 17:20:09 to 17:21:01 | Phone open, threads running | 8,281 KB in 53 s, in steps of about 216 KB, one shell push each |

An answer cost 6.3 MB because it made two whole-shell trips: the reply to `command` is the shell after the command, and
then `checkDelivery` read the shell again before reading the answer's receipt. Both waited on one socket, and a message on
it waits behind every byte before it.

An ordinary reply makes one trip. Its marker usually settles from the command's own shell, which leaves `checkDelivery`
nothing to check, so it reads the shell again only when another marker is still waiting or that shell did not confirm the
reply. That comes from reading the code: no reply was sampled from the phone. One whole shell is still about 3 MB on the
laptop today, about 6 s at 0.5 MB/s, and this change does not touch it. #2002 and #2020 do.

The link is what makes this intermittent. It carried about 6 MB/s at 17:23, and the owner saw that reply clear
in about a second. At 17:01 the same phone took 1.1 MB over three seconds, about 0.5 MB/s. Its sockets closed as that run
ended, so that rate is a sign rather than a measurement. At 0.5 MB/s the same answer would take about 13 s and a connect about 10 s.

## What changed

After a command's reply, or Watcher's page after an answer from its card, the iPhone reads only receipts. It still reads
the whole shell after a reconnect and when the user presses Check again. `testAnAnswerReadsItsReceiptWithoutTheWholeShellAgain` fails
without this.

Repeatable measure, on the real listener, with 632 synthetic thread records of 2,147 bytes and no Watcher page:

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/phoneAnswerBytes.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

| One answer | Reply | Shell read | Before | After |
|---|---|---|---|---|
| Host without the connect cuts | 1,559 KB | 1,559 KB | 3,118 KB | 1,559 KB |
| Host with them | 27 KB | 27 KB | 54 KB | 27 KB |

On a real computer the shell is larger, since it carries the model catalog and Watcher's page.

| One answer, real computer | Before | After |
|---|---|---|
| Laptop today, measured before and worked out after | 6.3 MB | about 3.2 MB |
| Laptop with #2002 and #2020, worked out from `2026-11-01-phone-connect-size.md` | about 590 KB | about 295 KB |

The first of those needs only a new TestFlight build. The second also needs the next Owl on the laptop, which also cuts an
ordinary reply from about 3 MB to about 295 KB and a connect from about 5 MB to about 600 KB. So most of the owner's wait
goes when that Owl is installed, and this change takes the second trip off answers on top. The after figures have not been
read off a phone yet: the fix reaches one only once TestFlight has it. To read them, run the sampler above during an answer.

## What this did not settle

- **Connecting that a fresh launch cleared.** The owner saw the laptop say Connecting for under a minute, closed the app,
  and it connected at once. It did not happen again while the sockets were logged, so its cause is not known. Three things
  fit: a hello that outlasted its 30 second deadline on a slow moment; the quiet retries' waits of up to 30 s, which a fresh
  launch skips; and an HTTP connection gone dead in the URL session, which a fresh launch replaces. The first goes away with
  the connect cuts.
- **A half-dead socket does not explain the slow sends.** Sends and answers reached the laptop and finished there in under
  a second, with the phone taking bytes throughout. Nothing here rules out a half-dead socket as a separate, rarer wait
  (#696).
- **Shell pushes.** At about 156 KB/s while a phone is open they take a third of a 0.5 MB/s link. Most of each is Watcher's
  page. How many of them Watcher's own wake-ups cause was not measured.
