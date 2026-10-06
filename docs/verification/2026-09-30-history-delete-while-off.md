# Delete retained dictation history while history is off

Issue #495 (S-014). The owner's decision is to delete retained dictation transcripts from disk while **Keep local history** is off, with no UI change.

## Reproduction and cause

Before the fix, the new Electron regression in `tests/e2e/app.spec.ts` confirmed that Delete closed its dialog and removed the row while `history.json` still held the synthetic transcript. IPC passed `enabled: false` to the repository's delete guard. AppContext ignored the returned false and replaced its cached history with the disabled list's empty result.

Deletion now takes only the retained record's ID, independent of recording history. AppContext honours a false result through its existing history failure path, without reloading an empty list or reporting success. After a successful delete with history off, it removes only that ID from the cached entries; with history on it reloads the list. List, search and recording remain gated by the history setting.

## Verified journeys

- The repository preserves another retained record, removes the selected record from the JSON file, and a newly opened repository cannot restore it. Disabled recording still saves nothing and disabled listing stays empty.
- IPC sends a delete while history is off without imposing the recording setting.
- AppContext returns false and keeps both cached entries when deletion is refused. A successful retry removes only the selected entry, and the other entry can then be deleted while history stays off.
- The built Electron app records two synthetic dictations and keeps both cached rows after history is turned off. The first Delete leaves one visible row and one record in `history.json`; the remaining row can still be expanded and deleted. Re-enabling history and reloading the renderer leaves the History page empty.

The IPC and AppContext regressions failed before the production change. The Electron regression separately failed on the retained on-disk text before the change and passed afterward.

The PR #620 rework extended the AppContext regression to two retained entries. Before the rework it failed because the first successful delete left an empty cache instead of the remaining entry. The extended test passes after filtering the cache while history is off. The redundant artifact ignores were removed because the existing review-directory patterns already cover generated files; the two committed captures below remain tracked.

## Visual inspection

Inspected the real Electron captures on Windows. [Retained history while off](../../artifacts/review-history-delete/retained-history-off.png) shows the existing expanded row, Copy and Delete controls, and the history-off footer. [After deletion and reload](../../artifacts/review-history-delete/deleted-after-reload.png) shows the existing empty History page. There are no component, styling, keyboard, copy or baseline changes.

These journeys use Sotto's deterministic test boundary and synthetic text. They do not send audio to a provider or use a personal profile. No manual mouse/keyboard session or macOS execution is claimed.
