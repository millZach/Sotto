# Prompt format review

These are actual text-only native outputs from four synthetic conversations. Source-quote validation passed. Semantic fidelity and usefulness require reading each output; automated validation does not establish them. Human review is pending, so the format is provisional.

Rubric (0–2 each): objective fidelity; latest corrections; decisions versus suggestions; constraints/non-goals; deliverables/acceptance; unresolved details; useful standalone wording. A hard failure is any invented requirement, unaccepted suggestion promoted to a decision, discarded correction, silently resolved contradiction or omitted essential constraint.

## short-missing-details

Review checks: Tea timer objective retained. Platform and durations remain open. Presets and notifications must not become requirements. No invented platform, duration or notification permission.

### Conversation

**user:** I want a simple timer for my tea. I have not decided which platform or how long the timers should be.

**assistant:** We could offer presets and notifications. Would you prefer phone or desktop?

### Generated prompt

## Objective
- Create a simple tea timer.

## Unresolved questions
- Which platform should the timer use?
- How long should the timers be?

## Suggestions to review
- Consider presets and notifications; neither is an accepted requirement.

---

## latest-correction

Review checks: Desktop, single article and local bookmarks replace phone, three columns and account sync. No sharing. Prototype and save/restart acceptance retained. Recommendations remain unaccepted.

### Conversation

**user:** Build a reading app for my phone. Use a three-column layout with bookmarks synced to an account.

**assistant:** I suggest adding recommendations and sharing.

**user:** Correction: desktop only, one article at a time. Keep bookmarks local; no account or sharing. Deliver a working prototype. I should be able to save an article, close the app, and find it after reopening.

### Generated prompt

## Objective
- Build a desktop reading app.

## Accepted decisions
- Display one article at a time.
- Keep bookmarks local.

## Constraints and non-goals
- Support desktop only; do not include accounts or sharing.

## Deliverables
- Deliver a working prototype.

## Acceptance checks
- A saved article remains available after closing and reopening the app.

## Suggestions to review
- Optionally consider recommendations; this suggestion has not been accepted.

---

## unresolved-conflict

Review checks: Both demands retained as an unresolved conflict. Reconnect sync is only a suggestion. Editing/deletion authority remains open. No invented resolution or permission model.

### Conversation

**user:** Design a team task list. It must always work offline and every edit must immediately appear for every teammate, even when their computers have no network.

**assistant:** Those requirements conflict during disconnection. We could synchronize after reconnecting.

**user:** I need to think about that tradeoff. Do not choose for me. We also have not chosen who may edit or delete tasks.

### Generated prompt

## Objective
- Design a team task list.

## Constraints and non-goals
- The task list must always work offline.
- Do not choose how to resolve the offline synchronization tradeoff for the user.

## Unresolved questions
- How should the conflict between always working offline and immediately showing every edit to every teammate without a network be resolved? The user has not chosen a tradeoff.
- Who may edit or delete tasks?

## Suggestions to review
- Option to consider, not an accepted requirement: synchronize after reconnecting.

---

## long-brainstorm

Review checks: Searchable Windows local table, fields, quantity buttons/direct edit, nonnegative quantity, delete confirmation and CSV export retained. Latest supplier correction excludes supplier links. No dashboard/map/import/photos/barcodes/accounts/auto merges/reordering. Duplicate handling and example inventory remain open. Accepted quantity-button proposal distinguished from other suggestions; all named deliverables/checks retained.

### Conversation

**user:** I want a workshop inventory app to find my parts quickly. We should brainstorm before building.

**assistant:** Possible directions: a photo catalog, a spreadsheet-like table, or a map of drawers.

**user:** Use a searchable table. Each part has a name, quantity and drawer. The map seems distracting.

**assistant:** We could add barcodes, reorder thresholds and supplier links.

**user:** Supplier links would be useful later. Skip barcodes and automatic reordering for the first version.

**assistant:** How should quantity changes work? Perhaps plus and minus buttons beside each row.

**user:** Yes, use those quantity buttons. Never allow a negative quantity. Also allow editing a quantity directly.

**assistant:** An undo history could help recover mistakes.

**user:** For the prototype, just ask before deleting a part. Keep the interaction simple.

**assistant:** Do you want the data on this computer or synchronized between devices?

**user:** This Windows computer only. Store locally. I do not need accounts or cloud services.

**assistant:** We can include CSV import and export. Should part photos be mandatory?

**user:** Export to CSV is required. No import yet. Photos can wait too.

**assistant:** A multi-page dashboard could show total value, part counts and recent activity.

**user:** No dashboard. Open directly to the table, and search names and drawers from one search box.

**assistant:** Should a duplicate part name merge quantities automatically?

**user:** I have not decided how duplicates work. Keep that question open. Avoid automatic merges.

**assistant:** We could store the supplier link as another table column now.

**user:** Actually leave supplier links out of the prototype completely. Deliver the app and instructions for running it. Verify add, search, edit quantity, delete confirmation, restart persistence and CSV export. I will provide example parts later; do not invent my inventory.

### Generated prompt

## Objective
- Create a workshop inventory app to find parts quickly; brainstorm before building.

## Relevant context
- The app is for one Windows computer.

## Accepted decisions
- Use a searchable table with a name, quantity and drawer for each part.
- Provide plus and minus quantity buttons beside each row and allow direct quantity editing.
- Ask for confirmation before deleting a part; keep prototype interactions simple.
- Store data locally, without accounts or cloud services.
- Open directly to the table and use one search box to search names and drawers.
- Support CSV export.

## Constraints and non-goals
- Never allow negative quantities.
- Exclude the drawer map and dashboard.
- Exclude barcodes and automatic reordering from the first version.
- Defer CSV import and photos.
- Leave supplier links out of the prototype completely.
- Do not automatically merge duplicate parts.
- Do not invent the user's inventory; example parts will be provided later.

## Deliverables
- Deliver the app and instructions for running it.

## Acceptance checks
- Verify adding parts, searching, editing quantities, delete confirmation, persistence after restart and CSV export.

## Unresolved questions
- How should duplicate parts be handled, without automatic merging? Keep this undecided.

## Suggestions to review
- Optional, unaccepted idea: reorder thresholds.