# Babysitting surfaces verification

October 8, 2026. Issue #825, on `feat/babysit-surfaces`, stacked on #824's `feat/babysit-tool` (PR #832) at a8849ed1b.
Zach picked variant C, "A state of its own", from #822's prototype on October 8; ADR-0061 records it under **The look**,
and its #825 amendment records the one thing building it decided: clients are now told why babysitting ended
(`babysitEnded`), so the Pull request surface can say so without guessing.

## What was driven

The journey is `tests/e2e/babysitting.spec.ts`, over the built app (`npm run build`), the scripted provider and the
scripted `gh` in `tests/fixtures/fakeGh.mjs`, which now answers babysitting's fingerprint and detail reads from the same
records the surface reads. A babysitting pass runs when the journey asks, through the unpackaged-only hook in
`src/main/e2e/babysitPass.ts`, rather than on the two-minute timer. Everything else is the real reader, the real
wake-up wording and the real send path through the follow-up queue.

1. **Start from the surface.** The thread links #74, open with its build still running. In Tools → Pull request the
   ··· menu lists Convert to draft, Merge when ready (auto-merge), **Babysit pull request**, Copy link, Link pull
   request, Unlink from thread and Close pull request, in that order. It opens from the keyboard, answers Escape with
   focus back on ···, and Babysit pull request is reached with the arrow keys and Enter. The panel says "Babysitting
   #74" in passing, at its foot; nothing is added above the checklist, so it stays where it was.
2. **The line, the row and the pose.** A line docked under the checklist and above Merge says "Babysitting since 4:12
   pm" and "Started by you. Sotto sends this thread a wake-up when #74 needs it.", with **Stop**, named "Stop
   babysitting #74". The sidebar row reads **Babysitting #74**. Above the composer the creature rests in the muted
   colour with its sign, over "#74 Greet the reviewer" and "Babysitting since 4:12 pm"
   ([1280x800 dark](../../artifacts/babysitting-surfaces/babysitting-1280x800-dark.png)). The pose is named as one
   picture, "Babysitting #74 Greet the reviewer since 4:12 pm", and is not a live region, so it is not read out again
   each time it comes back after a turn. The journey measures where the time sits rather than trusting one capture: at
   1280x800 with Tools open, today's time shows whole, and so does the widest one ("since 12:55 pm") put in its place;
   an earlier day's ("since Oct 17, 12:55 pm") either shows whole or drops whole, never cut by an ellipsis. The line's title, words and
   Stop, the row's state and both lines of the pose measure 4.5:1 or better on what they sit on, in dark and in light.
   Under reduced motion the pose is the same still pose. At the 820x560 minimum nothing overflows, the line keeps its
   words and Stop, and the pose's time, real or widest, shows whole or drops whole
   ([820x560 dark](../../artifacts/babysitting-surfaces/babysitting-820x560-dark.png), where it shows whole); at
   1600x1000 the widest shows whole.
3. **A wake-up in the thread.** The first pass, with the build running, tells nothing. The build then fails on GitHub,
   and the next pass sends the thread a wake-up at once: on the user's side, labelled **Sotto** and **Wake-up**, with
   every word the provider received, "- Check CI / Owned build failed:" as text rather than a list, and both links as
   links ([wake-up](../../artifacts/babysitting-surfaces/wake-up-1280x800-dark.png)). The row says Working, and the pose
   steps aside while the turn runs. When the turn ends the row says Babysitting #74 again, or Just finished when the
   window was not in front, which outranks it.
4. **A wake-up waiting in the queue.** With the thread busy and a follow-up of the user's queued, a second check
   failing brings a wake-up that waits after it, named "Sotto · Wake-up", with Remove only and no Edit or move arrows;
   the user's own item no longer offers to move past it. The transcript echoes it where it will go as Sotto's, word for
   word ([queued](../../artifacts/babysitting-surfaces/queued-wake-up-1280x800-dark.png)). Remove takes it away and
   babysitting goes on; no wake-up is sent for it.
5. **Stop.** The panel says "Stopped babysitting #74" in passing, the line goes, focus waits on ···, where Babysit pull request
   is again, and the row and the pose go back to rest.
6. **Ended on its own.** Started again from ···, then merged on GitHub: the next pass sends the last wake-up ("It
   merged, so Sotto has stopped babysitting it.") and ends babysitting. After Refresh the surface shows Merged into main
   and under it "Babysitting ended. Ended when #74 merged at 3:13 pm."
   ([ended](../../artifacts/babysitting-surfaces/ended-1280x800-dark.png)).
7. **Settings.** Settings → Application has **Let agents babysit pull requests** right after "Let agents draw visuals in
   threads", on by default, saying what Sotto does with the value shown, and its description changes when it is
   turned off and back on.

The existing `tests/e2e/pull-request-surface.spec.ts` passes unchanged over the same build.

## What the unit tests hold

`tests/unit/renderer/babysitting.test.ts` holds the line's states and words, where Babysit pull request is offered and
the sidebar's state word; `threadSidebarStatus.test.tsx` the row's ranking; `babysittingPose.test.tsx` the pose's ranking
and readout; `wakeUpMessage.test.tsx` that a wake-up is told by its mark and never its words, in the transcript, the
queue and the queue's echo; `pullRequestSurface.test.tsx` the menu item, the line, Stop and refusals;
`settingsView.test.tsx` the switch; and `workspaceBabysitting.test.ts` and `agentRuntimeBabysitting.test.ts` that why
babysitting ended is kept on the thread's record through a restart, and not for the user's own Stop.

## Not driven

- A paired host: offering the control only where the host lists `pull-request-babysit` is held by unit tests over
  `clientHosts[].pullRequestBabysit`, not by a journey with a remote host.
- An agent starting babysitting with its tool: the line's "Started by Claude Code" wording is unit-tested; the tool is
  #824's and its own tests drive it.
- Phones: nothing in `apps/ios` changed. They read a wake-up as an ordinary message and ignore `babysitEnded`.
