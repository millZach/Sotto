# iPhone working status

Follow-up to #468 in `.worktrees/fix-ios-working-status`, based on `dc4d9af4`.

The user reports all threads read Done while two are working. Desktop agreement and installed TestFlight build were asked but are not yet confirmed.

- [x] Reproduce a status mismatch in actual Swift decoding/classification and AppModel live updates.
- [x] Include confirmed background work and running compaction in labels, filters and Needs you working rows.
- [x] Preserve questions, errors, foreground work and completed-work transitions.
- [x] Review a throwaway status prototype using the existing visual language.
- [ ] Pass focused regressions, full required gates and independent review.
- [ ] Deliver the correction through PR, merge and TestFlight under the continuing authorized workflow.
- [ ] Verify the user's exact iPhone/laptop case; no device access is available locally.

Observed red: foreground updates are recognized, but idle plus confirmed background work reads Done and vanishes from Working. Running compaction also reads Done. The transport test uses real IncomingFrame decoding and AppModel with scripted transport; it is not a real phone connection.

The prototype was inspected in dark and light at 375 px width, including Working for an idle turn with a background agent and Waiting for a command. It is archived on `prototype/ios-working-status`; these are HTML captures, not native iPhone evidence.
