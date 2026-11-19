//! The invented conversation: 200 earlier messages and one long reply.
//!
//! Everything here is made up. The reply is Markdown of about 4,000 words with
//! headings, nested lists, two tables, inline code, links, six fenced code
//! blocks (TypeScript, Rust, JSON, shell), one unified diff of about 200 lines
//! and twelve activity rows, written as fenced ```activity blocks so the stream
//! stays plain text. It is built deterministically, so every run streams the
//! same bytes.

pub struct EarlierMessage {
    pub from_user: bool,
    pub time: String,
    pub markdown: String,
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn pick<'a>(&mut self, items: &'a [&'a str]) -> &'a str {
        items[(self.next() % items.len() as u64) as usize]
    }
    fn range(&mut self, lo: usize, hi: usize) -> usize {
        lo + (self.next() % (hi - lo + 1) as u64) as usize
    }
}

const OPENERS: &[&str] = &[
    "The harbor scheduler",
    "The lantern queue",
    "The tide planner",
    "Each berth worker",
    "The manifest reader",
    "The night shift runner",
    "The dock ledger",
    "The crane allocator",
    "The pilot roster",
    "The weather gate",
];

const MIDDLES: &[&str] = &[
    "now reads its limits from one place instead of three",
    "keeps the order of arrivals even when two ships report at the same second",
    "stops retrying once the berth says it is full",
    "writes a single line to the ledger for every hand-off",
    "waits for the tide table before it promises a slot",
    "drops the stale entries that were left behind by the old importer",
    "measures how long each crane sits idle between lifts",
    "hands back a plain reason when it refuses a booking",
    "no longer copies the whole roster on every update",
    "treats a missing manifest as an error the user can fix",
    "sorts the queue by the time a ship was promised, not the time it was seen",
    "keeps the old file format readable so nobody loses a week of bookings",
];

const CLOSERS: &[&str] = &[
    "which is what the failing test expected all along.",
    "so the night report finally matches what the cranes did.",
    "and the change is small enough to read in one sitting.",
    "which removes the race we saw on Tuesday.",
    "so the numbers in the dashboard stop drifting.",
    "and nothing else in the module had to move.",
    "which keeps the hot path free of extra allocations.",
    "so a slow pilot no longer holds up the whole harbor.",
];

const ASIDES: &[&str] = &[
    "I checked this against the recorded run from last week.",
    "The fixture in `tests/harbor/arrivals.json` covers the edge case.",
    "None of this touches the public API.",
    "The old behaviour is still there behind `legacyOrdering`, off by default.",
    "I left a comment where the ordering rule lives, since it is easy to break.",
    "This is the part I would review most carefully.",
    "The timing numbers come from the bench in `bench/queue.rs`.",
    "If the tide table is missing, the planner says so and stops.",
];

fn sentence(rng: &mut Rng) -> String {
    format!("{} {}, {}", rng.pick(OPENERS), rng.pick(MIDDLES), rng.pick(CLOSERS))
}

fn paragraph(rng: &mut Rng, sentences: usize) -> String {
    let mut out = Vec::new();
    for i in 0..sentences {
        if i > 0 && rng.next() % 3 == 0 {
            out.push(rng.pick(ASIDES).to_string());
        } else {
            out.push(sentence(rng));
        }
    }
    out.join(" ")
}

const ACTIVITIES: &[(&str, &str)] = &[
    ("Read `src/harbor/scheduler.ts`", "412 lines. The ordering rule is in `pickNextBerth`, lines 188 to 240."),
    ("Searched for `promisedAt` in 38 files", "Found 14 uses. Three of them compare against `seenAt` by mistake."),
    ("Ran `npm test -- tests/harbor`", "41 passed, 2 failed: arrivals keep their order; a full berth stops retrying."),
    ("Edited `src/harbor/scheduler.ts`", "+38 −21. Sorted by `promisedAt`, added the full-berth stop."),
    ("Read `crates/ledger/src/lib.rs`", "The ledger writes one line per hand-off already; nothing to change there."),
    ("Ran `cargo test -p ledger`", "17 passed in 1.9 s."),
    ("Edited `config/harbor.json`", "Moved the three retry limits into one `limits` object."),
    ("Ran `npm test -- tests/harbor`", "43 passed."),
    ("Read `docs/harbor.md`", "The doc still names the old retry flag. Updated below."),
    ("Edited `docs/harbor.md`", "+6 −4. Names the new `limits` object and what each limit does."),
    ("Ran `npm run lint`", "No problems."),
    ("Ran `bench/queue` three times", "Median 2.1 ms per thousand arrivals, down from 3.4 ms."),
];

fn activity(i: usize) -> String {
    let (title, body) = ACTIVITIES[i % ACTIVITIES.len()];
    format!("```activity\n{title}\n{body}\n```\n\n")
}

const TS_ONE: &str = r#"```ts
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
```"#;

const TS_TWO: &str = r#"```ts
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
```"#;

const RUST_ONE: &str = r#"```rust
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
```"#;

const RUST_TWO: &str = r#"```rust
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
```"#;

const JSON_ONE: &str = r#"```json
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
```"#;

const SHELL_ONE: &str = r#"```sh
# Run the harbor suite, then the ledger crate, then the queue bench.
npm test -- tests/harbor
cargo test -p ledger
cargo run --release -p bench --bin queue -- --arrivals 1000 --runs 3
git diff --stat
```"#;

/// A unified diff of a little over 200 lines against an invented TypeScript file.
fn diff() -> String {
    let mut lines = vec![
        "```diff".to_string(),
        "diff --git a/src/harbor/scheduler.ts b/src/harbor/scheduler.ts".to_string(),
        "index 3f2a9c1..8be04d7 100644".to_string(),
        "--- a/src/harbor/scheduler.ts".to_string(),
        "+++ b/src/harbor/scheduler.ts".to_string(),
    ];
    let mut old_line = 12;
    let mut new_line = 12;
    let names = ["north", "east", "south", "west", "pier", "quay", "slip", "mole"];
    for hunk in 0..8 {
        let context_before = 3;
        let removed = 3 + hunk % 3;
        let added = 4 + hunk % 4;
        let context_after = 3;
        let old_count = context_before + removed + context_after + 8;
        let new_count = context_before + added + context_after + 8;
        lines.push(format!(
            "@@ -{old_line},{old_count} +{new_line},{new_count} @@ export function {}Berths() {{",
            names[hunk]
        ));
        for c in 0..context_before {
            lines.push(format!("   const {}{c} = queue.at({c})", names[hunk]));
        }
        for r in 0..removed {
            lines.push(format!("-  if (arrival.seenAt < {}Limit{r}) retry(arrival, {r})", names[hunk]));
        }
        for a in 0..added {
            lines.push(format!(
                "+  if (arrival.promisedAt < limits.{}[{a}]) return refuse(arrival, 'full')",
                names[hunk]
            ));
        }
        for c in 0..context_after {
            lines.push(format!("   ledger.note({}{c}, 'kept')", names[hunk]));
        }
        for c in 0..8 {
            lines.push(format!("   // {} berth rule {c}: ships keep the order they were promised", names[hunk]));
        }
        old_line += old_count + 20;
        new_line += new_count + 21;
    }
    lines.push("```".to_string());
    lines.join("\n")
}

const TABLE_ONE: &str = "| Limit | Before | After | Where it lives |\n| --- | --- | --- | --- |\n| Retries | 3, 5 or 8 | 4 | `limits.retries` |\n| Back-off | 100 ms | 250 ms × attempt | `limits.backoffMs` |\n| Queue length | none | 512 | `limits.maxQueue` |\n| Wind gate | 30 kn | 34 kn | `weatherGate.maxWindKnots` |\n| Gate closes after | never | 20 min | `weatherGate.closeAfterMinutes` |";

const TABLE_TWO: &str = "| Run | Arrivals | Median | 95th percentile | Allocations |\n| --- | ---: | ---: | ---: | ---: |\n| Before, run 1 | 1,000 | 3.4 ms | 5.9 ms | 12,880 |\n| Before, run 2 | 1,000 | 3.5 ms | 6.1 ms | 12,880 |\n| After, run 1 | 1,000 | 2.1 ms | 3.0 ms | 4,102 |\n| After, run 2 | 1,000 | 2.0 ms | 3.1 ms | 4,102 |\n| After, run 3 | 1,000 | 2.1 ms | 2.9 ms | 4,102 |";

/// The long reply, as one Markdown string.
pub fn long_reply() -> String {
    let mut rng = Rng(0x5077_0bad_cafe);
    let mut md = String::new();
    let mut activity_ix = 0;
    fn next_activity(md: &mut String, ix: &mut usize) {
        md.push_str(&activity(*ix));
        *ix += 1;
    }
    macro_rules! push_activity {
        ($md:expr) => {
            next_activity($md, &mut activity_ix)
        };
    }

    push_activity!(&mut md);
    push_activity!(&mut md);
    md.push_str("# What changed in the harbor scheduler\n\n");
    md.push_str(&paragraph(&mut rng, 5));
    md.push_str(" The short version is in the [harbor notes](https://example.invalid/harbor-notes), and the rest of this reply walks through each part.\n\n");
    md.push_str(&paragraph(&mut rng, 4));
    md.push_str("\n\n");

    md.push_str("## The ordering rule\n\n");
    md.push_str(&paragraph(&mut rng, 4));
    md.push_str(" The rule now lives in `pickNextBerth`, and it sorts by `promisedAt` first and by the ship's name second.\n\n");
    md.push_str(TS_ONE);
    md.push_str("\n\n");
    push_activity!(&mut md);
    md.push_str(&paragraph(&mut rng, 5));
    md.push_str("\n\n");
    md.push_str("Three things had to hold for the rule to be right:\n\n");
    md.push_str("1. Ships keep the order they were promised.\n   - Two ships promised the same second are ordered by name.\n   - A ship seen early never jumps the queue.\n     - Not even when its berth is already free.\n     - Not even after a restart.\n2. A full berth stops the retries.\n   - The reason names when a berth will be free.\n3. Nothing is booked twice.\n   - The ledger refuses a hand-off that goes back in time.\n\n");
    push_activity!(&mut md);
    md.push_str(&paragraph(&mut rng, 6));
    md.push_str("\n\n");

    md.push_str("## Retries and the full berth\n\n");
    md.push_str(&paragraph(&mut rng, 5));
    md.push_str("\n\n");
    md.push_str(TS_TWO);
    md.push_str("\n\n");
    push_activity!(&mut md);
    md.push_str(&paragraph(&mut rng, 4));
    md.push_str("\n\n");
    md.push_str("- What the booking returns now:\n  - `ok: true` with the berth's name, or\n  - `ok: false` with a reason a person can act on.\n- What it no longer does:\n  - retry forever when the ledger is down;\n  - swallow the full-berth answer.\n\n");

    md.push_str("## The limits, in one place\n\n");
    md.push_str(&paragraph(&mut rng, 4));
    md.push_str("\n\n");
    md.push_str(JSON_ONE);
    md.push_str("\n\n");
    md.push_str(TABLE_ONE);
    md.push_str("\n\n");
    push_activity!(&mut md);
    md.push_str(&paragraph(&mut rng, 5));
    md.push_str("\n\n");

    md.push_str("## The ledger\n\n");
    md.push_str(&paragraph(&mut rng, 5));
    md.push_str("\n\n");
    md.push_str(RUST_ONE);
    md.push_str("\n\n");
    push_activity!(&mut md);
    md.push_str(&paragraph(&mut rng, 4));
    md.push_str("\n\n");
    md.push_str(RUST_TWO);
    md.push_str("\n\n");
    push_activity!(&mut md);
    md.push_str(&paragraph(&mut rng, 5));
    md.push_str("\n\n");

    md.push_str("## The whole change\n\n");
    md.push_str(&paragraph(&mut rng, 3));
    md.push_str(" Here is the diff for the scheduler, which is most of it:\n\n");
    md.push_str(&diff());
    md.push_str("\n\n");
    push_activity!(&mut md);
    push_activity!(&mut md);
    md.push_str(&paragraph(&mut rng, 5));
    md.push_str("\n\n");

    md.push_str("## Labels the harbor office asked for\n\n");
    md.push_str("The office in Muscat wants the refusal reason in Arabic, and the Karachi office in Urdu. Both lines below are what the planner shows:\n\n");
    md.push_str("تم رفض الحجز لأن كل الأرصفة ممتلئة. حاول مرة أخرى بعد 14:30، أو اتصل بـ harbor-desk.\n\n");
    md.push_str("بکنگ نہیں ہو سکی کیونکہ تمام برتھ بھری ہوئی ہیں۔ 14:30 کے بعد دوبارہ کوشش کریں، یا harbor-desk سے رابطہ کریں۔\n\n");
    md.push_str("The Yokohama and Shanghai offices get the same line: 予約できませんでした。すべてのバースが満杯です。 and 预订失败，所有泊位都已满。\n\n");

    md.push_str("## Measuring it\n\n");
    md.push_str(&paragraph(&mut rng, 4));
    md.push_str("\n\n");
    md.push_str(SHELL_ONE);
    md.push_str("\n\n");
    push_activity!(&mut md);
    md.push_str(TABLE_TWO);
    md.push_str("\n\n");
    push_activity!(&mut md);
    md.push_str(&paragraph(&mut rng, 5));
    md.push_str("\n\n");

    // Fill with sections until the reply reaches about 4,000 words.
    let mut section = 0;
    let topics = [
        "What I did not change",
        "Edge cases worth a second look",
        "How the night report reads now",
        "What the crane numbers say",
        "Follow-ups",
        "Notes for the reviewer",
        "Why the old importer left stale entries",
        "The weather gate",
    ];
    while word_count(&md) < 3_850 {
        md.push_str(&format!("### {}\n\n", topics[section % topics.len()]));
        let n = rng.range(4, 7);
        md.push_str(&paragraph(&mut rng, n));
        md.push_str("\n\n");
        if section % 2 == 0 {
            md.push_str(&format!(
                "- {}\n  - {}\n- {}\n\n",
                sentence(&mut rng),
                rng.pick(ASIDES),
                sentence(&mut rng)
            ));
        }
        section += 1;
    }
    while activity_ix < 12 {
        push_activity!(&mut md);
    }
    md.push_str("That is everything. The suite is green, the bench is faster, and the limits live in one file. See the [review checklist](https://example.invalid/review) before merging.\n");
    md
}

pub fn word_count(md: &str) -> usize {
    md.split_whitespace().count()
}

const USER_ASKS: &[&str] = &[
    "Can you look at why the harbor queue drops ships after a restart?",
    "Run the harbor suite again and tell me what fails.",
    "Make the refusal reason say when a berth will be free.",
    "Why does the night report show two hand-offs for the same ship?",
    "Move the retry limits into `config/harbor.json`.",
    "Check whether the ledger still reads last month's files.",
    "What does `pickNextBerth` do when two ships arrive in the same second?",
    "Keep the old ordering behind a flag, off by default.",
    "Please write the bench numbers into a table.",
    "Is the weather gate still at 30 knots?",
];

/// 200 earlier messages, alternating, oldest first.
pub fn earlier_messages() -> Vec<EarlierMessage> {
    let mut rng = Rng(0x1234_5678_9abc);
    let mut out = Vec::with_capacity(200);
    for i in 0..200 {
        let from_user = i % 2 == 0;
        let minutes = 8 * 60 + i * 2;
        let time = format!("{}:{:02} {}", ((minutes / 60) + 11) % 12 + 1, minutes % 60, if minutes / 60 < 12 { "am" } else { "pm" });
        let markdown = match (from_user, i) {
            (true, 190) => "Before you finish, check the labels for the Muscat and Karachi offices: «تم رفض الحجز» and «بکنگ نہیں ہو سکی». They should read right to left.".to_string(),
            (false, 191) => "تم تحديث الملف config/harbor.json بنجاح، ويمكنك الآن تشغيل npm test مرة أخرى.\n\nمیں نے فائل scheduler.ts میں تبدیلی کر دی ہے، اب npm test چلائیں۔\n\nBoth labels now lay out right to left, with the file names kept in their own direction.".to_string(),
            (true, 196) => "设置 page and 設定画面 should use the same wording as the desktop. Can you check?".to_string(),
            (false, 197) => "我已经更新了配置文件，请再运行 `npm test`。\n\n設定ファイルを更新しました。次に `cargo test` を実行してください。".to_string(),
            (true, _) => rng.pick(USER_ASKS).to_string(),
            (false, _) => {
                let n = rng.range(2, 4);
                let mut text = paragraph(&mut rng, n);
                if i % 6 == 1 {
                    text.push_str(&format!("\n\n- {}\n- {}", sentence(&mut rng), sentence(&mut rng)));
                }
                text
            }
        };
        out.push(EarlierMessage { from_user, time, markdown });
    }
    out
}

/// The question that starts the long reply.
pub const LAST_ASK: &str = "Walk me through the whole harbor change: the ordering rule, retries, the limits, the ledger and the diff, with the bench numbers.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reply_matches_the_brief() {
        let reply = long_reply();
        let words = word_count(&reply);
        assert!((3_800..=4_400).contains(&words), "{words} words");
        assert_eq!(reply.matches("```activity").count(), 12);
        for lang in ["```ts", "```rust", "```json", "```sh"] {
            assert!(reply.contains(lang), "{lang}");
        }
        let fences = reply.matches("```ts").count() + reply.matches("```rust").count() + reply.matches("```json").count() + reply.matches("```sh").count();
        assert_eq!(fences, 6);
        let diff = diff();
        let lines = diff.lines().count();
        assert!((195..=230).contains(&lines), "{lines} diff lines");
        assert_eq!(reply.lines().filter(|line| line.starts_with("| ---")).count(), 2);
        assert_eq!(earlier_messages().len(), 200);
    }
}
