# Thread, turn and feature product events

ADR-0179. Run on forge on November 2, 2026, on a real headless host with the fake provider, and a local server standing in for the Worker. The desktop that connected said the switch was on. No build sends anything yet: there is still no built-in endpoint.

## What a real host sent

The test made a project and a thread titled with the word "private", sent a prompt with that word, and ended the turn by hand, because the fake provider leaves its turn running. These are the bodies that reached the server, without the `uuid`, `distinct_id` and `timestamp` every event carries.

```json
{"event":"thread.started","properties":{"provider":"codex","effort":"low","permissionMode":"approval-required","startedBy":"user","inWorktree":false,"appVersion":"0.1.42","channel":"stable","surface":"host","platform":"linux","arch":"x64","$process_person_profile":false,"$geoip_disable":true}}
{"event":"turn.completed","properties":{"provider":"codex","effort":"low","permissionMode":"approval-required","startedBy":"user","speed":"standard","result":"completed","durationMs":1502,"appVersion":"0.1.42","channel":"stable","surface":"host","platform":"linux","arch":"x64","$process_person_profile":false,"$geoip_disable":true}}
```

The fake provider's model is not on the public list, so no `model` went. It reports no usage, so no token counts went.

Searching everything sent found no "private", no thread ID and no path.

## What this did not prove

- No real provider ran a turn. All eight adapters mark a turn running and ended, by reading their code, and `tests/integration/productEventsThreads.test.ts` runs main's real update path with a stand-in adapter.
- Token counts come from the update path test, not this run.
- `feature.used` is proved by a test at each call site. It was not seen going out of a running app, which the notice's real run will show.
- A turn can go uncounted, by design: one that starts and ends inside one publication of about 16 ms, one whose outcome a reconnect lost, and a fork's first turn after a restart before it was sent.
- Two rare cases read wrong the other way, as `src/main/productEvents/threadEvents.ts` says: Muse recovering a lost turn gives the new one the old one's start, and Grok reading back shrunken history can count an old turn again.
- Nothing has reached the live Worker, which also needs deploying with this schema first, since `permissionMode` became optional.
