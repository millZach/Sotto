# Usage counts every client's work on each computer

October 14, 2026. Local verification of the Usage rework on `fix/usage-all-work`, which carries out [ADR-0083](../adr/0083-usage-counts-every-clients-work-on-each-computer.md). Zach reported that the first Usage build showed almost nothing for any range, doubled providers on Subscriptions, read Claude's limits late and wrongly, listed one model twice and did not look like the C · Focus design he had approved. He overruled ADR-0078's boundaries, chose to count everything each computer's clients did with Sotto's share told apart, and picked **3 · Where view** from a prototype built with his real numbers. Nothing was installed, packaged or published.

## The design against what shipped

The first build kept C · Focus's layout, headline measures on the left and one large view on the right, and dropped most of the rest. Its provider marks were all white. It had underlined tabs, Refresh and trash buttons where C has pill tabs and a … menu, and Room left as a plain number with no rings. Prompts had ISO dates and unlabelled bars, Tokens a plain bar and six boxes, Subscriptions one card per provider per computer with names like "Codex primary window", and Models two columns with Opus 5.5 listed twice.

The rebuilt page follows C · Focus: pill tabs and a … menu, Room left with a ring per provider that turns amber when low, labelled charts with plain dates, Tokens as one bar split by kind, one Subscriptions section per provider with windows named by length and a mark for the time left, and Models with a bar per model split by kind, Prompts, Tokens and From cache columns and an All models total. Each provider's mark has its own colour from its `--tt-provider-*` token. Variant 3 adds the Everywhere / In Sotto / Outside Sotto menu that every number follows, the Where headline and the Where you work view.

## Production Windows journeys

`npm run build` passed. The final run of `tests/e2e/usage-dashboard.spec.ts`, `native-usage-persistence.spec.ts` and `thread-thinking.spec.ts` passed four journeys in 41.7 seconds on production Electron main, the native Claude adapter, the real preload and IPC bridge and the SQLite store, with a scripted Claude client in an isolated profile and the network off. The scripted client answers `get_usage`, so the journey reads Claude's limits on open the way a real Claude Code does.

The [numeric evidence](../../artifacts/usage-rework/verified.json) records zero page errors and these outcomes:

- One accepted send counts once, under the model that served it: selected `claude-sonnet-4-6`, served `claude-opus-5-5`, one row named Claude Opus 5.5.
- 1,000 uncached, 2,000 cache-read and 500 cache-write input tokens make 3,500 input; with 100 output the total is 3,600 and From cache is 57%.
- A stale Clear is refused, a fresh Clear empties the figures and keeps replayed groups out, and a new turn counts afterwards. The figures survive history being off, a graceful restart and replay without being counted twice.
- A stable launch over the Owl database shows no Usage and no preload bridge, and leaves the database bytes unchanged.

| Capture | Content size | Visible-text contrast minimum |
| --- | --- | --- |
| [Overview, dark](../../artifacts/usage-rework/overview-dark-1600.png) | 1600 × 1000 | 7.1:1 |
| [Tokens, dark](../../artifacts/usage-rework/tokens-dark-1280.png) | 1280 × 800 | 7.1:1 |
| [Subscriptions, light, at the minimum](../../artifacts/usage-rework/subscriptions-light-820.png) | 820 × 562 | 6.05:1 |
| [Models, light](../../artifacts/usage-rework/models-light-1280.png) | 1280 × 800 | 6.05:1 |
| [Overview, dark, at the minimum](../../artifacts/usage-rework/overview-dark-820.png) | 820 × 562 | 7.1:1 |

All five were opened and inspected. This display returns 562 content pixels for the 820 × 560 minimum; the JSON records requested and actual sizes. At the minimum the headline measures scroll sideways in their own strip and the page has no horizontal overflow. The opened About disclosure measured 6.72:1. The captures hold synthetic figures only.

The first pass of these captures showed "Grok Build isn't connected on This computer." Sentences now lower-case this computer wherever its name falls mid-sentence, and the Subscriptions capture above was taken after that fix.

## This computer's real records

Two runs read Zach's real Claude Code transcripts and Codex rollouts. Both printed counts and totals only; their captures stay on his computer, because they show his own figures.

The adapter-level run drove the real Claude and Codex history readers through Sotto's thread translation into a copy of his usage store, with copies of his thread stores for the place split. Claude's records took 35 seconds and Codex's 63. Undated rows fell from 43,013 to 35, under 0.1% of the tokens, each in a thread whose other rows were dated. A separate scan written independently of the importer agreed with it to 0.14% overall and within 1.5% for every app and place. A Usage query over the whole history took 90 milliseconds, and 56 for 30 days. Run again after each later Codex fix, the last time on the final code, it gave the same figures for every app and place apart from work done in between, and a second pass straight after added only the rows written since the first.

The in-app run, on the build before the review fixes, launched the built Owl app over a fresh profile with Claude Code, Codex and Grok Build connected. The first history pass finished in two and a half minutes, dated everything back to April 21, 2026, and matched the adapter-level total to 0.2%, the difference being work done between the runs. Reopening Usage painted in 29 milliseconds and the full figure read took 212. The store was 218 MB. There were no page errors at 1600 × 1000, 1280 × 800 or the minimum, in dark or light. A fresh profile has no Sotto threads, so this run counted Sotto's Claude Code work as outside Sotto; the place split was checked by the adapter-level run, which had his thread stores.

Live limits read on open: Codex's week, Claude's 5 hours, week and Fable week, and Grok Build's week, which reports its reset but not how much is used. Devin's limits remain unreadable, as before. The first in-app run counted about a fifth more tokens than the independent scan, all of it in Codex. Forked and subagent rollouts begin with a copy of another session's history, sometimes without that session's header, and `subagent_history_start_ordinal` does not mark where the copy ends; a nested subagent can also name the top thread while copying an intermediate one. The copy now ends at the first running total the source session never had, and the [research note](../research/2026-10-12-provider-usage-dashboard.md) records what was found.

## Gates and review

`npm run typecheck`, `npm run lint` and `npm run notices:verify` passed on the final code, the last verifying 189 third-party components.

`npm test -- --maxWorkers=2` on the tree merged with main ran 11,324 tests: 10,977 passed, 346 were skipped and one failed, because main's question visibility work had also taken ADR-0080. The Usage decision is now ADR-0083, since open PR #1035 holds 0081 and 0082, and the release tests that check the numbers pass. An earlier run lost an hour to the laptop sleeping and was discarded.

Two review rounds on both axes by GPT-6.1 Sol at max reasoning found, among others, a Codex request counted twice across passes, unknown and partial figures printed as exact counts, cache use shown as 0% when unreported, extra usage left visible when Claude turned it off, older hosts' model details losing their days, and native identities not hashed. Every finding was fixed in its own commit. A third round on those fixes found a nested subagent's copy counted again when an earlier pass had read the subagent it copied, a subagent's later request dropped when another session's had the same figures, older hosts' dated model spellings missing from model details, and more totals, shares and names that needed the same care. Those were fixed too, the Codex ones each with a test that fails without the fix.

A fourth round found the same copy counted again two generations down, a small incomplete share still reading "under 1%", and the From cache view calling reported tokens absent; those are fixed. It also found that two subagents' own requests equal in every figure are taken for one copied request. That stays, and the research note says why: a copied line gets a new timestamp and often a new turn ID, so equal running totals are the only sign of a copy, and unrelated sessions on this laptop shared 2 of 137,613. Siblings can't be measured for that, since their copies share totals by design. A fifth round found the descendant reading stopping at eight generations and missing fork links, and reported cache reads called no token counts; those are fixed, each with a test that fails without the fix. Its standards axis found nothing new.

Not verified: forge and the Mac, whose own history appears once each runs an Owl host with this importer; Linux and macOS desktop journeys; packaged builds, which CI's Package result checks. `get_usage` is marked experimental by Claude Code's maker; a client without it falls back to the limits Claude Code reports during work.
