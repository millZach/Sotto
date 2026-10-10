# Codex restored replies: two-axis review

Test citations use the current split files. Recorded counts and outcomes are from the original runs.

Pinned base: `65e944a7` (Sotto 0.1.26). The first three reports reviewed the initial repair plus the main merge; the fourth reviewed the working tree with the first round of fixes. Reports below are retained separately by axis and reviewer slot. Line numbers refer to each review's snapshot.

GPT-6-astra could not read the Windows checkout because its sandbox failed while applying deny-read ACLs. Grok 4.7 returned progress text without a usable review (the spec run was stopped after it stalled). Each slot therefore used the skill's Opus 5.5 fallback, with read-only plan permissions through the native Claude reviewer CLI. No reviewer modified files.

## Standards

### Opus 5.5 (GPT fallback)

I found 5 documented-standard violations and 4 smells; none are blocking bugs, but the first one is a documented rule. Base is `65e944a7`, diff is `47edfafc` plus the main merge, and nothing was modified.

## Documented-standard violations

1. **`CONTEXT.md` is now wrong. It wasn't updated.** Its "Thread event" entry (line 155) lists every event kind, and `message-aliased` isn't there. The kind is added at `src/shared/threadEvents.ts:271-272`. The new wording also clashes with the glossary:
   - "alias" already means **Codex provider session alias** (line 141).
   - Line 279 says to avoid "receipt" alone, but the ADR text, the schema comment and the note all use it.
   - Breaks AGENTS.md "Read first": a new idea needs a new glossary entry, and reusing a word that already means something else is the failure the rule warns about.
2. **ADR-0005 isn't amended.** Line 37 describes suppression by the envelope's "explicit client ID". The diff now also reads the nested `item.client_id` (`codexSessionLog.ts:191-193`) and adds alias repair (`codex.ts:143-152`, `160-169`). Only ADR-0016 records this. Breaks AGENTS.md "Before opening a pull request" (fix the ADR a change makes wrong).
3. **The verification note has stale and missing evidence.**
   - `docs/verification/codex-restored-replies.md:109` still says the fix is "local and uncommitted".
   - Line 101 cites `artifacts/codex-restored-replies/full-suite.txt`, but that file is gitignored and not committed.
   - Breaks AGENTS.md: `artifacts/<slug>/` holds what the note cites.
4. **A test gate is red.** Note line 101 records one full-suite failure and says it is "not reported as green". Breaks AGENTS.md "a red gate is fixed at its cause". This is an open item, not a defect in the code.
5. **The guide entry is in the wrong place.** `docs/guide.md:467` sits under `## Troubleshooting` but above `### Either platform`, outside the per-platform sections. It belongs under "Either platform". This is a doc-structure issue with no specific rule behind it.

## Judgement calls (baseline smells)

- **Possible Duplicated Code.** The same content check exists in two places:
  - `threadMessageLog.ts:212-214`: `duplicate.role !== canonical.role || duplicate.text !== canonical.text || duplicate.commandId && …`
  - `threadStore.ts:240-244` does the same in SQL.
  - ADR-0016 only asks for the store's check. When `track.messages` is not loaded, the log version skips the check but still drops the ID (`threadMessageLog.ts:209-218`). The store might refuse that same alias, so the log's in-memory view and the store could disagree.
- **Possible Duplicated Code.** `codex.ts:145` and `codex.ts:158` both build `this.aliases[id]!.messageIdentities.flatMap(turn => turn.messages)` and search native IDs.
- **Possible Mysterious Name.** In `codex.ts:162`, `const aliases = new Map<string, typeof records>()` sits beside `this.aliases[id]` in the same method, with a different meaning (native ID → candidate records).
- **Possible Divergent Change / Mysterious Name.** `orderMessages` (`codex.ts:892-172`) now also writes `message-aliased` events, which its name doesn't say.

## Minor

- The ADR-0016 amendment is inserted at line 39, before "Considered options". Every other ADR-0016 amendment is after it (lines 66, 77, 87), so this one breaks the file's layout.
- The `README.md:37` line reads like release notes, and the README is the overview. Judgement call.


### Opus 5.5 (Grok fallback)

I found three documented-standard violations and five judgement calls in the diff from `65e944a7`. Nothing breaks privacy, authority or thread identity: the new `message-aliased` event carries only message IDs, logs nothing, and keeps messages with a different `commandId`.

**Documented-standard violations**

1. **`CONTEXT.md:155` is now out of date.** The "Thread event" entry lists the event kinds, and `message-aliased` (`src/shared/threadEvents.ts:27-28`) isn't among them. The rule is AGENTS.md: "a change that makes one wrong fixes it in the same PR: `CONTEXT.md` when a term is new or has moved". The "Codex session log" entry (`CONTEXT.md:143`) also still describes matching by digest only. It doesn't mention the nested `item.client_id` check (`codexSessionLog.ts:116-118`).
2. **The verification note cites a file that wasn't committed.** `docs/verification/codex-restored-replies.md:21` cites `artifacts/codex-restored-replies/full-suite.txt`. That folder is gitignored and only the four PNGs are tracked. The rule is AGENTS.md: `artifacts/<slug>/` holds what the note cites.
3. **The same note is stale about the commit.** `docs/verification/codex-restored-replies.md:29` says "The fix is local and uncommitted", but it is committed in 47edfafc. The rule is AGENTS.md: a document the change makes wrong is fixed in the same PR.

**Judgement calls**

- **Mysterious Name.** In `src/main/agents/codex.ts:897`, `const aliases = new Map<string, typeof records>()` sits next to `this.aliases[id]` in the same method. Something like `canonicalByNativeId` would be clearer.
- **Divergent Change.** `orderMessages` now writes durable `message-aliased` events (`codex.ts:895-904`). Its doc comment (`codex.ts:886-889`) still says it is "rather than a change to what was said".
- **Duplicated Code.**
  - `codex.ts:869` and `:893` both repeat `this.aliases[id]!.messageIdentities.flatMap(turn => turn.messages)`.
  - The content-equality check is written twice, in JS at `threadMessageLog.ts:314-316` and in SQL at `threadStore.ts:556-561`, and the two already differ.
    - Attachments are compared as `JSON.stringify` of the objects in one and as the stored strings in the other.
    - When `track.messages` isn't loaded, the in-memory alias removes the duplicate with no content check. The store may then keep it, so memory and store can disagree.
  - `threadMessageLog.ts:321-323` repeats the same shape three times: `if (track.lastX?.id === messageId) track.lastX = canonical ? { ...canonical } : undefined`.
- **Inconsistent proof between the two alias paths.** `addRolloutMessage` (`codex.ts:867-876`) checks role and digest but not `complete`. `orderMessages` checks `complete` but not role or digest. ADR-0016's new amendment says "Codex applies the same proof" on both paths, and as written it doesn't.
- **Placement in the guide.** The new bullet at `docs/guide.md:467` sits directly under `## Troubleshooting`, above `### Either platform`. It isn't platform-specific, so it belongs inside that subsection with the others.

**No finding**

- The commit subject and body follow the rules.
- The `.gitignore` and `eslint.config.mjs` lines for the new artifacts folder are present.
- The ADR-0016 amendment is used correctly and keeps `messages-reset` for rewinds only.
- The local full-suite failure is written up openly and isn't called green. CI hasn't confirmed the gate.


## Spec

### Opus 5.5 (GPT fallback)

**Review of `65e944a7...HEAD` (47edfafc plus the merge of main)**

**(c) Incorrect implementation**

1. **Confirmed: the new event breaks the frozen host protocol.** `src/shared/threadEvents.ts:28` adds `message-aliased` to `threadEventSchema`. That schema is part of `hostEventPageSchema` and `hostHelloSchema` (`src/shared/hostProtocol.ts:145`). ADR-0025:66 says "v1 changes only by adding an optional field, a feature in `features`, or a push form a client asks for in `accepts`. Anything else is version 2." An older desktop client checks hello and event pages against the strict union (`socketHostService.ts:139`, `:301`). If a page holds an alias event, that client fails the whole page. There is no feature flag, and `docs/host-protocol.md` is unchanged. This goes against the spec's "preserve … history".

2. **Confirmed: the in-memory log can remove a message the store keeps.** When a thread's log holds IDs but no text (`threadMessageLog.ts:208`, `:85`, `:101`), `alias()` skips its content check (`:312-314`) and removes the ID anyway. The repair loop that calls it (`codex.ts:902`) does not compare role or text, unlike `:908`. If the store then refuses the alias, memory and store disagree. Separately, `lastUser`, `lastAssistant` and `last` become `undefined` rather than the canonical message whenever that message isn't held in memory (`threadMessageLog.ts:319-321`), so the thread's summary can lose its last prompt. The ADR amendment says "Equal words alone never establish an alias", so a skipped check can't count as proof.

3. **Judgement call: the two alias paths check ambiguity differently.** `addRolloutMessage` (`codex.ts:869-871`) filters by role and digest before counting matches, and doesn't check `!order.has(message.id)` or `complete`. `orderMessages` does both (`:902`), with the comment "Never collapse an ID that names another canonical message." One shared guard would keep them in line.

4. **Judgement call: repair now permanently deletes rows on weaker evidence than it claims.** `nativeIds` can come from matching by position between anchors (`codexMessageIdentity.ts:104-114`) and from rollout event IDs built from a text digest (`:41`, `:154`). Before this change that evidence only filtered the display (`codex.ts:908`); now it deletes rows from the store. The store's equality check means no distinct content is lost. But two genuinely separate native inputs with the same words could still be merged, which strains "Distinct native input with identical words remains visible" (verification note line 93).

**(a) Missing or partial**

5. `docs/verification/codex-restored-replies.md:109` says "The fix is local and uncommitted." That is stale now the fix is committed.
6. Line 101 of the same note cites `artifacts/codex-restored-replies/full-suite.txt`. The folder is gitignored and the file isn't in the diff, so the citation points at nothing.
7. The full suite wasn't green (line 101). AGENTS.md asks for the gates in CI form before a PR, so that failure needs a green rerun of the whole suite, not only the isolated test.
8. `docs/guide.md:467` puts the new bullet between `## Troubleshooting` and `### Either platform`, outside any platform subsection.

**(b) Scope creep**

None found. The README, ADR, guide, `workspace.ts:1152` and the e2e captures all follow from the fix.

**Replay traced, no defect found**

- Rebuild keeps the repair: the alias event comes after both `message-added` rows.
- Restarting doesn't re-add the duplicate. It is left out of the seeded IDs, and the second alias call does nothing.
- After redaction the equality check has only empty text left to compare, but only pairs that were already checked are ever replayed, so this is safe.
- The alias event carries no text, so privacy holds, and it touches no permission records.


### Opus 5.5 (Grok fallback, after the first fixes)

The core fix is right, and I found no defect in the repair logic. What I did find: two confirmed doc defects, verification evidence that predates the uncommitted review fixes, and one judgement call about pointer handling in the message log. I reviewed `git diff 65e944a7` against the working tree, uncommitted review fixes included.

**(a) Missing or partial requirements**

1. **Verification evidence is stale** (partly confirmed). Spec: *"See … docs/verification/codex-restored-replies.md."*
   - Confirmed: line 3 says "against Sotto 0.1.24's source", but the base is `Release 0.1.26`.
   - Judgement call: lines 16, 18 and 20 report "35 focused tests … six files" and a full suite of 6,250 passed. The uncommitted fixes came after those runs: `reconcileMessages` was rewritten, and the diff adds `ThreadStore.message`, the `message-aliases` negotiation and a new `tests/integration/socketClientIsolation.test.ts` case. The gates need re-running on this tree and the counts updating.

**(b) Scope creep**

None of substance. The `message-aliases` negotiation (`hostProtocol.ts:33`, `socketServer.ts:150`, `socketHostService.ts:138`) is justified: it keeps the new event kind away from clients built before it existed. One judgement call: the new Codex sentence in the README (line 74) sits inside the "Privacy and cost" section, which isn't about privacy or cost.

**(c) Incorrect implementation**

1. **`CONTEXT.md:155` repeats a clause** (confirmed). The `message-aliased` clause appears twice, word for word.
2. **`CONTEXT.md:143` has a broken character** (confirmed). "Sotto?s" contains a literal `?` (byte 0x3F) where the apostrophe should be.
3. **`threadMessageLog.ts:321-324` points "last message" at the wrong message** (judgement call). When the duplicate was the newest message, `alias` sets `last`, `lastUser` and `lastTextId` to the canonical message, which is older than anything saved between the two.
   - How it happens: a failed read (`codex.ts:724` or `:848`) flushes a no-client rollout row that has no complete record yet, so it is added after the reply. The next successful read's `reconcileMessages` then aliases it.
   - Effect: `lastMessageId` returns the prompt instead of the reply, so new activity is anchored before the reply (`codex.ts:913`, `:979`).
   - The unit test at `threadMessageLog.test.ts:29-38` has nothing between the two messages, so it can't catch this.

**Paths I traced and found correct**

- **Repeated native IDs:** `canonicalReplay` (`codex.ts:269-274`) refuses when any saved message already uses the native ID as its own, or when more than one record claims it. The loop in `reconcileMessages` skips the same cases.
- **Conflicting content:** the digest check in `canonicalReplay` and `sameMessageContent` (`threadEvents.ts:5-9`) must both pass. The store checks again when it applies the event (`threadStore.ts:560-566`), so different text, a different role, a different command or attachments block the removal. The same order of events gives the same result when the projection is rebuilt.
- **Native input and authority:** a receipt whose two client IDs disagree is not treated as Sotto's (`codexSessionLog.ts:116-118`). An outside message with identical words stays visible and unowned, as the integration test at line 45 shows. Nothing touches the history epoch or policy records.
- **Original reconnect journey:** saved duplicates are repaired when a buffered row is flushed on read, or by `reconcileMessages` over seeded IDs. It stays conservative when the store is unavailable, because `workspace.ts:1020` returns `undefined`.
- **Clients that don't accept `message-aliases`:** `latestSeq` still advances over the unfiltered page, and the iPhone app skips event history anyway.

This was a read-only review; nothing was modified.


## Disposition

The repair now uses one native identity guard for incoming and saved messages, refuses ambiguous IDs before matching content, and checks indexed saved messages with the same content predicate in the adapter log and event-store projection. Missing saved content leaves the message alone. The log retains the newest remaining message for activity anchors and summaries, even when a duplicate of an older prompt arrived last. Regression tests cover seeded IDs, unwatched summaries with intervening messages, ambiguous native IDs, different stored words, and distinct outside input with identical text.

Remote clients opt into `message-aliases`; older clients receive compatible event pages with advancing cursors and read the corrected detail. Tests cover hello, explicit event reads, and pushed pages for both client versions. Existing native identity reconciliation was retained: equal words alone still prove nothing. The later spec review found its conservative identity checks correct.

The glossary, ADR-0005, ADR-0016, protocol reference, README placement, guide placement, and evidence note were corrected. The new event has a distinct glossary term, message identity alias. The duplicated comparison and misleading ordering-method name were removed. The two short identity-list traversals remain local to the adapter; extracting another abstraction would not remove the different iteration responsibilities.

The initial gate failures are historical evidence, not a green claim. Final validation and CI status are recorded in the main verification note and PR. No release or installation was performed.

Standards: 19 top-level observations across both reports (overlaps included), with saved/log consistency the most consequential; Spec: 13 observations across both reports, with legacy protocol compatibility the most consequential. Concrete findings were addressed; final gates remain the merge condition.
