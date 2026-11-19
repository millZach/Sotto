```activity
Read `src/harbor/scheduler.ts`
412 lines. The ordering rule is in `pickNextBerth`, lines 188 to 240.
```

```activity
Searched for `promisedAt` in 38 files
Found 14 uses. Three of them compare against `seenAt` by mistake.
```

# What changed in the harbor scheduler

The weather gate sorts the queue by the time a ship was promised, not the time it was seen, so the night report finally matches what the cranes did. Each berth worker keeps the old file format readable so nobody loses a week of bookings, and the change is small enough to read in one sitting. The weather gate now reads its limits from one place instead of three, which is what the failing test expected all along. The night shift runner measures how long each crane sits idle between lifts, and nothing else in the module had to move. The dock ledger treats a missing manifest as an error the user can fix, and the change is small enough to read in one sitting. The short version is in the [harbor notes](https://example.invalid/harbor-notes), and the rest of this reply walks through each part.

The dock ledger treats a missing manifest as an error the user can fix, which removes the race we saw on Tuesday. The harbor scheduler treats a missing manifest as an error the user can fix, so a slow pilot no longer holds up the whole harbor. The manifest reader sorts the queue by the time a ship was promised, not the time it was seen, which is what the failing test expected all along. The timing numbers come from the bench in `bench/queue.rs`.

## The ordering rule

Each berth worker no longer copies the whole roster on every update, and the change is small enough to read in one sitting. The pilot roster no longer copies the whole roster on every update, so the night report finally matches what the cranes did. The old behaviour is still there behind `legacyOrdering`, off by default. The harbor scheduler writes a single line to the ledger for every hand-off, so a slow pilot no longer holds up the whole harbor. The rule now lives in `pickNextBerth`, and it sorts by `promisedAt` first and by the ship's name second.

```ts
export interface Arrival {
  ship: string
  berth?: string
  promisedAt: number
  seenAt: number
}

/** Picks the next berth, in the order ships were promised a slot. */
export function pickNextBerth(queue: Arrival[], free: Set<string>): Arrival | undefined {
  const waiting = queue
    .filter((arrival) => arrival.berth === undefined)
    .sort((a, b) => a.promisedAt - b.promisedAt || a.ship.localeCompare(b.ship))
  for (const arrival of waiting) {
    if (free.size === 0) return undefined
    return arrival
  }
  return undefined
}
```

```activity
Ran `npm test -- tests/harbor`
41 passed, 2 failed: arrivals keep their order; a full berth stops retrying.
```

Each berth worker sorts the queue by the time a ship was promised, not the time it was seen, so the numbers in the dashboard stop drifting. The night shift runner writes a single line to the ledger for every hand-off, which is what the failing test expected all along. The old behaviour is still there behind `legacyOrdering`, off by default. The pilot roster no longer copies the whole roster on every update, which is what the failing test expected all along. The fixture in `tests/harbor/arrivals.json` covers the edge case.

Three things had to hold for the rule to be right:

1. Ships keep the order they were promised.
   - Two ships promised the same second are ordered by name.
   - A ship seen early never jumps the queue.
     - Not even when its berth is already free.
     - Not even after a restart.
2. A full berth stops the retries.
   - The reason names when a berth will be free.
3. Nothing is booked twice.
   - The ledger refuses a hand-off that goes back in time.

```activity
Edited `src/harbor/scheduler.ts`
+38 −21. Sorted by `promisedAt`, added the full-berth stop.
```

The dock ledger stops retrying once the berth says it is full, which is what the failing test expected all along. The weather gate no longer copies the whole roster on every update, which keeps the hot path free of extra allocations. Each berth worker keeps the old file format readable so nobody loses a week of bookings, so the night report finally matches what the cranes did. This is the part I would review most carefully. The timing numbers come from the bench in `bench/queue.rs`. The manifest reader writes a single line to the ledger for every hand-off, and nothing else in the module had to move.

## Retries and the full berth

The harbor scheduler treats a missing manifest as an error the user can fix, so the night report finally matches what the cranes did. The lantern queue waits for the tide table before it promises a slot, which is what the failing test expected all along. The tide planner measures how long each crane sits idle between lifts, and the change is small enough to read in one sitting. None of this touches the public API. None of this touches the public API.

```ts
const limits = loadLimits('config/harbor.json')

export async function book(arrival: Arrival): Promise<Booking> {
  for (let attempt = 1; attempt <= limits.retries; attempt++) {
    const berth = await ledger.claim(arrival.ship)
    if (berth.kind === 'full') {
      return { ok: false, reason: `Every berth is full. Try again after ${berth.nextFreeAt}.` }
    }
    if (berth.kind === 'claimed') return { ok: true, berth: berth.name }
    await sleep(limits.backoffMs * attempt)
  }
  return { ok: false, reason: 'The ledger did not answer. Nothing was booked.' }
}
```

```activity
Read `crates/ledger/src/lib.rs`
The ledger writes one line per hand-off already; nothing to change there.
```

The dock ledger no longer copies the whole roster on every update, so the numbers in the dashboard stop drifting. I checked this against the recorded run from last week. The dock ledger keeps the order of arrivals even when two ships report at the same second, which removes the race we saw on Tuesday. The night shift runner sorts the queue by the time a ship was promised, not the time it was seen, which is what the failing test expected all along.

- What the booking returns now:
  - `ok: true` with the berth's name, or
  - `ok: false` with a reason a person can act on.
- What it no longer does:
  - retry forever when the ledger is down;
  - swallow the full-berth answer.

## The limits, in one place

The pilot roster writes a single line to the ledger for every hand-off, so the night report finally matches what the cranes did. I checked this against the recorded run from last week. The weather gate stops retrying once the berth says it is full, and the change is small enough to read in one sitting. The harbor scheduler writes a single line to the ledger for every hand-off, and the change is small enough to read in one sitting.

```json
{
  "limits": {
    "retries": 4,
    "backoffMs": 250,
    "maxQueue": 512
  },
  "berths": ["north-1", "north-2", "east-1", "east-2", "south-1"],
  "weatherGate": { "maxWindKnots": 34, "closeAfterMinutes": 20 },
  "legacyOrdering": false
}
```

| Limit | Before | After | Where it lives |
| --- | --- | --- | --- |
| Retries | 3, 5 or 8 | 4 | `limits.retries` |
| Back-off | 100 ms | 250 ms × attempt | `limits.backoffMs` |
| Queue length | none | 512 | `limits.maxQueue` |
| Wind gate | 30 kn | 34 kn | `weatherGate.maxWindKnots` |
| Gate closes after | never | 20 min | `weatherGate.closeAfterMinutes` |

```activity
Ran `cargo test -p ledger`
17 passed in 1.9 s.
```

The manifest reader treats a missing manifest as an error the user can fix, which is what the failing test expected all along. The dock ledger treats a missing manifest as an error the user can fix, so a slow pilot no longer holds up the whole harbor. The dock ledger stops retrying once the berth says it is full, which is what the failing test expected all along. I left a comment where the ordering rule lives, since it is easy to break. The crane allocator no longer copies the whole roster on every update, which removes the race we saw on Tuesday.

## The ledger

The harbor scheduler measures how long each crane sits idle between lifts, so the numbers in the dashboard stop drifting. The harbor scheduler sorts the queue by the time a ship was promised, not the time it was seen, which keeps the hot path free of extra allocations. If the tide table is missing, the planner says so and stops. The manifest reader sorts the queue by the time a ship was promised, not the time it was seen, which keeps the hot path free of extra allocations. The pilot roster measures how long each crane sits idle between lifts, and nothing else in the module had to move.

```rust
/// One line in the ledger for every hand-off between two workers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandOff {
    pub ship: String,
    pub from: Worker,
    pub to: Worker,
    pub at: u64,
}

impl Ledger {
    pub fn record(&mut self, hand_off: HandOff) -> Result<(), LedgerError> {
        if self.lines.last().is_some_and(|last| last.at > hand_off.at) {
            return Err(LedgerError::OutOfOrder { ship: hand_off.ship });
        }
        self.lines.push(hand_off);
        Ok(())
    }
}
```

```activity
Edited `config/harbor.json`
Moved the three retry limits into one `limits` object.
```

The dock ledger treats a missing manifest as an error the user can fix, so the night report finally matches what the cranes did. The old behaviour is still there behind `legacyOrdering`, off by default. This is the part I would review most carefully. The lantern queue hands back a plain reason when it refuses a booking, which keeps the hot path free of extra allocations.

```rust
fn idle_time(lifts: &[Lift]) -> Duration {
    lifts
        .windows(2)
        .map(|pair| pair[1].started.saturating_sub(pair[0].finished))
        .sum()
}

#[test]
fn idle_time_ignores_overlapping_lifts() {
    let lifts = [lift(0, 10), lift(5, 12), lift(20, 30)];
    assert_eq!(idle_time(&lifts), Duration::from_secs(8));
}
```

```activity
Ran `npm test -- tests/harbor`
43 passed.
```

Each berth worker stops retrying once the berth says it is full, so a slow pilot no longer holds up the whole harbor. The manifest reader waits for the tide table before it promises a slot, so a slow pilot no longer holds up the whole harbor. I checked this against the recorded run from last week. The crane allocator drops the stale entries that were left behind by the old importer, so the numbers in the dashboard stop drifting. This is the part I would review most carefully.

## The whole change

The night shift runner measures how long each crane sits idle between lifts, which is what the failing test expected all along. The tide planner keeps the old file format readable so nobody loses a week of bookings, which is what the failing test expected all along. The timing numbers come from the bench in `bench/queue.rs`. Here is the diff for the scheduler, which is most of it:

```diff
diff --git a/src/harbor/scheduler.ts b/src/harbor/scheduler.ts
index 3f2a9c1..8be04d7 100644
--- a/src/harbor/scheduler.ts
+++ b/src/harbor/scheduler.ts
@@ -12,17 +12,18 @@ export function northBerths() {
   const north0 = queue.at(0)
   const north1 = queue.at(1)
   const north2 = queue.at(2)
-  if (arrival.seenAt < northLimit0) retry(arrival, 0)
-  if (arrival.seenAt < northLimit1) retry(arrival, 1)
-  if (arrival.seenAt < northLimit2) retry(arrival, 2)
+  if (arrival.promisedAt < limits.north[0]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.north[1]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.north[2]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.north[3]) return refuse(arrival, 'full')
   ledger.note(north0, 'kept')
   ledger.note(north1, 'kept')
   ledger.note(north2, 'kept')
   // north berth rule 0: ships keep the order they were promised
   // north berth rule 1: ships keep the order they were promised
   // north berth rule 2: ships keep the order they were promised
   // north berth rule 3: ships keep the order they were promised
   // north berth rule 4: ships keep the order they were promised
   // north berth rule 5: ships keep the order they were promised
   // north berth rule 6: ships keep the order they were promised
   // north berth rule 7: ships keep the order they were promised
@@ -49,18 +51,19 @@ export function eastBerths() {
   const east0 = queue.at(0)
   const east1 = queue.at(1)
   const east2 = queue.at(2)
-  if (arrival.seenAt < eastLimit0) retry(arrival, 0)
-  if (arrival.seenAt < eastLimit1) retry(arrival, 1)
-  if (arrival.seenAt < eastLimit2) retry(arrival, 2)
-  if (arrival.seenAt < eastLimit3) retry(arrival, 3)
+  if (arrival.promisedAt < limits.east[0]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.east[1]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.east[2]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.east[3]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.east[4]) return refuse(arrival, 'full')
   ledger.note(east0, 'kept')
   ledger.note(east1, 'kept')
   ledger.note(east2, 'kept')
   // east berth rule 0: ships keep the order they were promised
   // east berth rule 1: ships keep the order they were promised
   // east berth rule 2: ships keep the order they were promised
   // east berth rule 3: ships keep the order they were promised
   // east berth rule 4: ships keep the order they were promised
   // east berth rule 5: ships keep the order they were promised
   // east berth rule 6: ships keep the order they were promised
   // east berth rule 7: ships keep the order they were promised
@@ -87,19 +91,20 @@ export function southBerths() {
   const south0 = queue.at(0)
   const south1 = queue.at(1)
   const south2 = queue.at(2)
-  if (arrival.seenAt < southLimit0) retry(arrival, 0)
-  if (arrival.seenAt < southLimit1) retry(arrival, 1)
-  if (arrival.seenAt < southLimit2) retry(arrival, 2)
-  if (arrival.seenAt < southLimit3) retry(arrival, 3)
-  if (arrival.seenAt < southLimit4) retry(arrival, 4)
+  if (arrival.promisedAt < limits.south[0]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.south[1]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.south[2]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.south[3]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.south[4]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.south[5]) return refuse(arrival, 'full')
   ledger.note(south0, 'kept')
   ledger.note(south1, 'kept')
   ledger.note(south2, 'kept')
   // south berth rule 0: ships keep the order they were promised
   // south berth rule 1: ships keep the order they were promised
   // south berth rule 2: ships keep the order they were promised
   // south berth rule 3: ships keep the order they were promised
   // south berth rule 4: ships keep the order they were promised
   // south berth rule 5: ships keep the order they were promised
   // south berth rule 6: ships keep the order they were promised
   // south berth rule 7: ships keep the order they were promised
@@ -126,17 +132,21 @@ export function westBerths() {
   const west0 = queue.at(0)
   const west1 = queue.at(1)
   const west2 = queue.at(2)
-  if (arrival.seenAt < westLimit0) retry(arrival, 0)
-  if (arrival.seenAt < westLimit1) retry(arrival, 1)
-  if (arrival.seenAt < westLimit2) retry(arrival, 2)
+  if (arrival.promisedAt < limits.west[0]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.west[1]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.west[2]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.west[3]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.west[4]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.west[5]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.west[6]) return refuse(arrival, 'full')
   ledger.note(west0, 'kept')
   ledger.note(west1, 'kept')
   ledger.note(west2, 'kept')
   // west berth rule 0: ships keep the order they were promised
   // west berth rule 1: ships keep the order they were promised
   // west berth rule 2: ships keep the order they were promised
   // west berth rule 3: ships keep the order they were promised
   // west berth rule 4: ships keep the order they were promised
   // west berth rule 5: ships keep the order they were promised
   // west berth rule 6: ships keep the order they were promised
   // west berth rule 7: ships keep the order they were promised
@@ -163,18 +174,18 @@ export function pierBerths() {
   const pier0 = queue.at(0)
   const pier1 = queue.at(1)
   const pier2 = queue.at(2)
-  if (arrival.seenAt < pierLimit0) retry(arrival, 0)
-  if (arrival.seenAt < pierLimit1) retry(arrival, 1)
-  if (arrival.seenAt < pierLimit2) retry(arrival, 2)
-  if (arrival.seenAt < pierLimit3) retry(arrival, 3)
+  if (arrival.promisedAt < limits.pier[0]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.pier[1]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.pier[2]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.pier[3]) return refuse(arrival, 'full')
   ledger.note(pier0, 'kept')
   ledger.note(pier1, 'kept')
   ledger.note(pier2, 'kept')
   // pier berth rule 0: ships keep the order they were promised
   // pier berth rule 1: ships keep the order they were promised
   // pier berth rule 2: ships keep the order they were promised
   // pier berth rule 3: ships keep the order they were promised
   // pier berth rule 4: ships keep the order they were promised
   // pier berth rule 5: ships keep the order they were promised
   // pier berth rule 6: ships keep the order they were promised
   // pier berth rule 7: ships keep the order they were promised
@@ -201,19 +213,19 @@ export function quayBerths() {
   const quay0 = queue.at(0)
   const quay1 = queue.at(1)
   const quay2 = queue.at(2)
-  if (arrival.seenAt < quayLimit0) retry(arrival, 0)
-  if (arrival.seenAt < quayLimit1) retry(arrival, 1)
-  if (arrival.seenAt < quayLimit2) retry(arrival, 2)
-  if (arrival.seenAt < quayLimit3) retry(arrival, 3)
-  if (arrival.seenAt < quayLimit4) retry(arrival, 4)
+  if (arrival.promisedAt < limits.quay[0]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.quay[1]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.quay[2]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.quay[3]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.quay[4]) return refuse(arrival, 'full')
   ledger.note(quay0, 'kept')
   ledger.note(quay1, 'kept')
   ledger.note(quay2, 'kept')
   // quay berth rule 0: ships keep the order they were promised
   // quay berth rule 1: ships keep the order they were promised
   // quay berth rule 2: ships keep the order they were promised
   // quay berth rule 3: ships keep the order they were promised
   // quay berth rule 4: ships keep the order they were promised
   // quay berth rule 5: ships keep the order they were promised
   // quay berth rule 6: ships keep the order they were promised
   // quay berth rule 7: ships keep the order they were promised
@@ -240,17 +253,20 @@ export function slipBerths() {
   const slip0 = queue.at(0)
   const slip1 = queue.at(1)
   const slip2 = queue.at(2)
-  if (arrival.seenAt < slipLimit0) retry(arrival, 0)
-  if (arrival.seenAt < slipLimit1) retry(arrival, 1)
-  if (arrival.seenAt < slipLimit2) retry(arrival, 2)
+  if (arrival.promisedAt < limits.slip[0]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.slip[1]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.slip[2]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.slip[3]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.slip[4]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.slip[5]) return refuse(arrival, 'full')
   ledger.note(slip0, 'kept')
   ledger.note(slip1, 'kept')
   ledger.note(slip2, 'kept')
   // slip berth rule 0: ships keep the order they were promised
   // slip berth rule 1: ships keep the order they were promised
   // slip berth rule 2: ships keep the order they were promised
   // slip berth rule 3: ships keep the order they were promised
   // slip berth rule 4: ships keep the order they were promised
   // slip berth rule 5: ships keep the order they were promised
   // slip berth rule 6: ships keep the order they were promised
   // slip berth rule 7: ships keep the order they were promised
@@ -277,18 +294,21 @@ export function moleBerths() {
   const mole0 = queue.at(0)
   const mole1 = queue.at(1)
   const mole2 = queue.at(2)
-  if (arrival.seenAt < moleLimit0) retry(arrival, 0)
-  if (arrival.seenAt < moleLimit1) retry(arrival, 1)
-  if (arrival.seenAt < moleLimit2) retry(arrival, 2)
-  if (arrival.seenAt < moleLimit3) retry(arrival, 3)
+  if (arrival.promisedAt < limits.mole[0]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.mole[1]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.mole[2]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.mole[3]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.mole[4]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.mole[5]) return refuse(arrival, 'full')
+  if (arrival.promisedAt < limits.mole[6]) return refuse(arrival, 'full')
   ledger.note(mole0, 'kept')
   ledger.note(mole1, 'kept')
   ledger.note(mole2, 'kept')
   // mole berth rule 0: ships keep the order they were promised
   // mole berth rule 1: ships keep the order they were promised
   // mole berth rule 2: ships keep the order they were promised
   // mole berth rule 3: ships keep the order they were promised
   // mole berth rule 4: ships keep the order they were promised
   // mole berth rule 5: ships keep the order they were promised
   // mole berth rule 6: ships keep the order they were promised
   // mole berth rule 7: ships keep the order they were promised
```

```activity
Read `docs/harbor.md`
The doc still names the old retry flag. Updated below.
```

```activity
Edited `docs/harbor.md`
+6 −4. Names the new `limits` object and what each limit does.
```

The tide planner now reads its limits from one place instead of three, so the night report finally matches what the cranes did. The crane allocator sorts the queue by the time a ship was promised, not the time it was seen, which keeps the hot path free of extra allocations. The lantern queue writes a single line to the ledger for every hand-off, so the numbers in the dashboard stop drifting. The night shift runner writes a single line to the ledger for every hand-off, so the night report finally matches what the cranes did. The harbor scheduler writes a single line to the ledger for every hand-off, and nothing else in the module had to move.

## Labels the harbor office asked for

The office in Muscat wants the refusal reason in Arabic, and the Karachi office in Urdu. Both lines below are what the planner shows:

تم رفض الحجز لأن كل الأرصفة ممتلئة. حاول مرة أخرى بعد 14:30، أو اتصل بـ harbor-desk.

بکنگ نہیں ہو سکی کیونکہ تمام برتھ بھری ہوئی ہیں۔ 14:30 کے بعد دوبارہ کوشش کریں، یا harbor-desk سے رابطہ کریں۔

The Yokohama and Shanghai offices get the same line: 予約できませんでした。すべてのバースが満杯です。 and 预订失败，所有泊位都已满。

## Measuring it

The night shift runner now reads its limits from one place instead of three, and the change is small enough to read in one sitting. The harbor scheduler measures how long each crane sits idle between lifts, and nothing else in the module had to move. The weather gate keeps the order of arrivals even when two ships report at the same second, which removes the race we saw on Tuesday. The old behaviour is still there behind `legacyOrdering`, off by default.

```sh
# Run the harbor suite, then the ledger crate, then the queue bench.
npm test -- tests/harbor
cargo test -p ledger
cargo run --release -p bench --bin queue -- --arrivals 1000 --runs 3
git diff --stat
```

```activity
Ran `npm run lint`
No problems.
```

| Run | Arrivals | Median | 95th percentile | Allocations |
| --- | ---: | ---: | ---: | ---: |
| Before, run 1 | 1,000 | 3.4 ms | 5.9 ms | 12,880 |
| Before, run 2 | 1,000 | 3.5 ms | 6.1 ms | 12,880 |
| After, run 1 | 1,000 | 2.1 ms | 3.0 ms | 4,102 |
| After, run 2 | 1,000 | 2.0 ms | 3.1 ms | 4,102 |
| After, run 3 | 1,000 | 2.1 ms | 2.9 ms | 4,102 |

```activity
Ran `bench/queue` three times
Median 2.1 ms per thousand arrivals, down from 3.4 ms.
```

The manifest reader sorts the queue by the time a ship was promised, not the time it was seen, and the change is small enough to read in one sitting. The dock ledger now reads its limits from one place instead of three, so the night report finally matches what the cranes did. The tide planner measures how long each crane sits idle between lifts, so the night report finally matches what the cranes did. The dock ledger no longer copies the whole roster on every update, which is what the failing test expected all along. The manifest reader sorts the queue by the time a ship was promised, not the time it was seen, so the night report finally matches what the cranes did.

That is everything. The suite is green, the bench is faster, and the limits live in one file. See the [review checklist](https://example.invalid/review) before merging.
