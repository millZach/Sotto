# Zoom, downloads, the agent's cursor, drawing and passkeys verification

November 27, 2026, on `feat/browser-parity-and-secret-requests`, on Windows 11 with Node 24.22.1 and Electron 43. This is [ADR-0222](../adr/0222-the-browser-zooms-downloads-shows-the-agents-cursor-and-takes-drawings.md), behind the `browser-parity` Owl feature, with the fixes a review of ADR-0220's branch asked for. `tests/e2e/browser-zoom-downloads.spec.ts` launched the built app (`npm run build`) with `SOTTO_OWL_FEATURES=browser-parity=1` over the fake Claude Code provider, against a page the test serves on loopback, and ran with `SOTTO_E2E_EVIDENCE=publish`. Captures are the window's own pixels (`desktopCapturer` by window title), so the native page is in them. Every capture in `artifacts/browser-zoom-downloads/` was looked at. The agent's calls go through `window.sottoE2E.browserAgent`, bound to the Workshop thread.

## What the spec checks

1. **Zoom keeps the agent exact.** The agent sets a 1000 by 600 viewport. At 50%, 100% and 175%, each reached with the pane's zoom, the page's `innerWidth` and `innerHeight` stay 1000 and 600, a click by ref on "Target 6" presses it, a click at the centre of "Target 3", read from the page, presses it, and the agent's screenshot is 1000 by 600 (`verification.json`, `zoomLandings`). Ctrl with = sent to the page twice gives 110% and then 125%, the chip says "Zoom 125%. Back to 100%", Ctrl with 0 gives 100% and the chip goes, and More's **Zoom in** gives 110%.
2. **The agent's cursor.** After the agent hovers at 950, 400 on a white part of the page, the page as Chromium draws it (a full `Page.captureScreenshot` from main) is coloured at 952, 408, inside the arrow, where it was white before. The agent's own screenshot straight after is white there. A recording made while the agent hovers across the page has coloured pixels in the blank band the cursor crossed, so the cursor is in recordings.
3. **A download the page starts.** The page's link to `/file.txt`, served as an attachment, is clicked in the page itself three and a half seconds after the agent's last action. The strip says "localhost:… wants to download a file. Where should it go?" with the file's name, and nothing is in the downloads folder. **Save to Downloads** saves it there with its contents; **Show in folder** and **Open** reach the system's shell with that path. **Hide** takes it off the page.
4. **A download an agent's click starts.** The agent clicks the link; its result says the page started downloading "bench-notes.txt" and that Sotto asks the user, and the strip says the agent's action started it. **Save as…** with the system dialog answered with the thread's `downloads/` folder saves it there. `browser_pages` then lists both downloads, the agent's with `path: "downloads/bench-notes.txt"` and the user's with no path, and nothing in its answer names the downloads folder. The page shows its own address again and is not loading, since the link never left it.
5. **The downloads list.** A new page's empty pane shows **Downloads this session** with both files, Open and Show in folder. Escape in its address goes back to the page.
6. **Drawing on the page.** **Draw on the page** puts the comment field in focus, says dictation types there, and hides the native page (no visible page view on the window). With a comment and a box drawn, **Add to message** says "Added to the draft for Workshop", and the draft holds one item named "Drawing on Zoom bench" carrying the comment, with the context saying the user drew on the screenshot; the draft's text stays empty. The focus returns to Draw on the page.
7. **Passkeys.** With Chromium's virtual authenticator on the page (the DevTools protocol's `WebAuthn` domain, from the test), the page's `navigator.credentials.create` made a passkey and `navigator.credentials.get` used it, with `isUserVerifyingPlatformAuthenticatorAvailable` true (`verification.json`, `passkeys`).

The spec passed in 43.8 seconds, with no page errors. Each capture's row is checked to stay inside the panel and clear of the window's own buttons.

## The passkey probe

Before building anything for passkeys, an Electron 43 probe opened a page in a `WebContentsView` set up as Sotto's are (sandboxed, context isolation, no preload) on a session whose permission request, check and device handlers refuse everything, as Sotto's do. `isUserVerifyingPlatformAuthenticatorAvailable` was true, and `navigator.credentials.create` stayed pending while Windows' own `CredentialUIBroker.exe` ran, which is Windows Hello's prompt; the probe aborted the request after three seconds. The permission handlers were never asked about WebAuthn. So no bridge is needed and nothing in Sotto blocks it (ADR-0222, decision 10).

## What the captures show

- **Zoom** (`zoom-menu-1280x800-dark.png`, and the chip in every `download-asking-*` capture, taken at 125%): More's Zoom in, Zoom out and **Actual size (now 100%)** with Ctrl+=, Ctrl+- and Ctrl+0 beside them; the "125%" chip with its magnifier after the address. At 820x560 the pane's row has no room for the percentage, so the chip is the magnifier alone, as Chrome's is, and its name still says 125%; the first run showed the chip pushing More under the window's buttons, which the row now prevents and the spec checks at every size.
- **The agent's cursor** (`agent-cursor-1280x800-dark.png`): the arrow in the theme's accent with its white edge over "Target 2", which shows its hover, where the agent pointed.
- **A download asking** (`download-asking-1600x1000-*`, `-1280x800-*`, `-820x560-*`, in dark, light and dark with reduced motion): the download icon, "localhost:… wants to download a file. Where should it go?", the file's name, and **Save to Downloads**, **Save as…** and **Cancel** in the strip's place. At 820x560 the question wraps to two lines and the buttons stay on one.
- **The agent's download** (`download-by-agent-1280x800-dark.png`): "The agent's action started a download from localhost:…".
- **Saved** (`download-saved-*`): "Saved bench-notes.txt in e2e-downloads" with Open, Show in folder and the close button.
- **The list** (`downloads-list-*`): under Servers started from Sotto and Open new pages in, **Downloads this session** with each file, where it is, Open, Show in folder and Remove from the list. At 820x560 each row's buttons go to a line of their own under the name.
- **Drawing** (`draw-on-page-*`): the editor's tools, colours and sizes over the frozen page with the red box drawn, **Cancel** and **Add to message**, then Your marks, the Comment with its words and the editor's keys. At 820x560 the picture is smaller and the comment stays in view.

Nothing here moves except the cursor's glide, which reduced motion turns into a jump (unit-tested: two draws for two hovers, at their points); the strip and list have no animation, so the reduced-motion captures match the others.

## Unit and integration tests

- `tests/unit/main/pageAutomation.test.ts` (new): zoom metrics, the cursor (arrow and ring through the overlay, glide and jump, off for every picture and back after, nothing without a style, with the catalog off or while pointing, never failing an action), typing a secret (focus checked before typing, the field named, a text field refused, clear), a document holding a secret (kept through a fragment change, a subframe, Stop sharing and a new attachment; ended by a main-frame commit), dialog words masked and withheld, the file chooser given back after a click, a failure and a dialog, with nothing sent while the dialog is open, the snapshot's total, attributes read in pairs, and masking in JSON, address and form encodings.
- `tests/unit/main/browserDownloads.test.ts` (new): names made safe, files that run programs, paused into Sotto's folder, Save to Downloads numbering, Save as cancelled, a cancel while the dialog is open, the agent's view and its path only inside the thread's folder, the sweep, the list's limit.
- `tests/unit/main/browserTools.test.ts`: zoom in the service and its refs, downloads in the service (asked, kept per thread, the agent's within three seconds, blocked with the catalog off, the page's address back after a link that downloads), the cursor style, a profile page's sharing kept to its site and its navigate asking every time, `browser_close` while the user holds the page, the user's hold moved by each input, and upload copies (a link out refused, a junction swapped in after the request given the copy, a copy changed before Allow refused).
- `tests/unit/main/browserFiles.test.ts`: staging, verify and discard.
- `tests/unit/main/browserParityTools.test.ts`: Antigravity's full-catalog calls refused over `tools/call` and directly, and downloads in `browser_pages`.
- `tests/unit/main/localServers.test.ts`: `::1`, German `netstat`, a content type in capitals, one deadline per probe, and a parent that started after its child not taken for it (Windows reuses an exited parent's ID).
- `tests/unit/host/browser/hostBrowser.test.ts` and `hostBrowserService.test.ts`: a main-frame commit on the host ends a secret's document; the host forwards the feature and its files folder and sweeps it.
- `tests/integration/secretParityCanary.test.ts` (new): one secret, typed by ref and by selector, never in a snapshot, result, task, event, page address or title, dialog refusal or the window's state, through a fragment change, Stop sharing and sharing again, with `evaluate` kept off for the rest of the page's life once the secret is typed (since the second review, below).
- `tests/unit/renderer/tools/browserZoomDownloads.test.tsx` (new): the zoom menu and chip, the download strip and list, the hook, the drawing editor's focus and Add, and "Allow this thread" hidden for an action that asks every time. `browserReview.test.tsx`: a drawing added as one draft item that says the user drew on it.
- `tests/unit/main/toolsIpc.test.ts`: 52 tools channels, the four new ones (zoom, downloads, download, cursorStyle) held to the main window and refused with the feature off.

## Gates

On `ebdac66fd`: `npm run typecheck`, `npm run lint`, `npm run notices:verify` (202 components), `npm run e2e:list` (693 tests in 305 files) and `npm run build` passed. The branch's journeys (`browser-zoom-downloads`, `browser-parity`, `secret-requests`, `browser-pane` and `paired-host-browser`) passed 6 of 7; `paired-host-browser.spec.ts:99`, a picture redrawn at a smaller pane, fails the same way on `origin/main` at 9220d0129. `npm run test:desktop-smoke` passed 12 and failed `daily-workspace.spec.ts:169`, and `npm run design:verify` passed 6 and failed `settings-providers-light`, `setup-welcome` and `scale-100-help`, as on `origin/main` (see the [first verification](2026-11-27-browser-parity.md#gates)).

The full `npm test -- --maxWorkers=2` run on `cecd8d007` found what this work broke, fixed in `ebdac66fd`:

- `hostProviderJob`, `pluginChangeTools` and `pluginMailSendTool`: refusing a tool a thread is not listed had gone into the shared thread tool server, so Watcher and a host's jobs lost their own answers. It is now the browser server's alone, for a thread on the stable catalog.
- `hostBuildScripts` and `stableHostPromotion`: upload copies used streams, which put `node:stream` in the paired host's bundle, outside its reviewed imports. They now copy in chunks through file handles.
- `pointerCursor`: a profile row had the pointer cursor, which Sotto keeps for links.
- `socketHostBrowser`: its fake page did not mask text as a real one does.

On `ebdac66fd` the full run passed 22,328 tests and failed 13. `socketHost` (two answer receipts) and `trackedFileEncoding` (its 60-second scan, under the run's load) passed when rerun on their own. The rest fail for reasons outside this branch, as before: `threadWorktreeReclaim` and `threadWorktreeInterruptedRemoval` fail on a clean main, `gitRepository` needs a Git with `gc --no-detach`, `liveChildSteps` needs the right to make symlinks, and `installedProvidersGate` finds this computer's Hermes.

## After the owner's review

The owner's review asked for these changes, recorded in ADR-0222's November 27 amendment:

- **Names (decision 3).** A download's name is held from the moment Sotto picks it until the file is placed. Two downloads of one name each get a name of their own, compared without case where the disk ignores case. **Save to Downloads** moves the file without replacing one: a hard link, or else a copy that refuses an existing file. If a file of that name appeared meanwhile, it takes the next free name. **Save as…** may still replace the file the user chose, but not a name another download holds.
- **What runs.** Sotto never opens disk images (`iso`, `img`, `vhd`, `vhdx`), or `chm`, `xll`, `appref-ms`, `msp`, `settingcontent-ms`, `library-ms` or `search-ms` files.
- **A closed thread.** A download still asking is cancelled at the moment its thread is deleted, or closed by its provider; the second review settled that the user's Settle leaves it waiting (below). The engine now tells the shell which threads are closed, and the shell acts only when a thread becomes closed or gone. A thread opened again keeps its new downloads.
- **What the agent hears (decision 5).** The agent hears only of downloads its own action started, and of those from a page that was shared with it when the download started and still is. The second review narrowed this to the second alone, the agent's own downloads among them ([below](#after-the-second-review)).
- **Zoom (decision 1).** A zoom is the site's by host name, as Chromium keeps it, so another port on the same host shares it.

`browserDownloads.test.ts`, `browserTools.test.ts` and `engineBoundary.test.ts` check these. Their new tests failed on the old code and pass. In the spec, which passed with the other browser journeys, the user's download from the agent's shared page is still listed for the agent. The gates are in [the first verification](2026-11-27-browser-parity.md#after-the-owners-review).

## After the second review

A second, independent review of the round above found these, recorded in ADR-0222's November 27 amendment:

- **Cancel while a file is placed (decision 3).** A Cancel that came while a finished download was being placed went ahead anyway. It could replace the file Save as chose and then delete it, free the name for another download whose file it then deleted, or be reported as failed. Placing now holds the name and the waiting folder until it ends. A Cancel stops a file that has not started to move, and one that has is saved; nothing deletes a file at a target.
- **What the agent hears (decision 5).** A download from a page the user had just made private still reached the agent when the agent had acted there in the last three seconds, a snapshot included. The agent now hears of a download only from a page shared with it when the download started and still, its own action's included. A read no longer counts as acting, and Stop sharing or a profile page leaving its site forgets the agent's last action. Names are masked as the page's other words are.
- **Zoom (decision 1).** A zoom now forgets the snapshot refs of every page on the host, not only what waits for the user there.
- **A closed thread, not changed.** The review read "settled" as the user's Settle, which never cancelled a download. That stays: Settle and Settle project keep running work and cards, and Undo brings the thread back (`CONTEXT.md`, **Settled** and **Settle toast**), while a cancelled download's file is gone for good. The amendment and the guide now say a download is cancelled when its thread is deleted or closed by its provider, and `engineBoundary.test.ts` pins that a settled thread or project ends nothing.

`browserDownloads.test.ts` holds each await of a placing with a gate on `node:fs/promises` and presses Cancel there. `browserTools.test.ts` covers the private-page, cross-site and action-answer cases, masked names, and a ref click after a zoom on both ports. The new tests failed on the old code and pass, except two that guard the new placing and passed before too: a Cancel while the next free name is found, and Sotto closing during mkdir. The gates are in [the first verification](2026-11-27-browser-parity.md#after-the-second-review).

## Not checked here

- macOS and Linux: zoom keys under Command, Touch ID or a Linux security key for passkeys, and the system Save dialog there.
- Windows Hello finishing a passkey: the probe saw its prompt open and cancelled it; making a real passkey needs a person at the computer.
- A paired host's page: zoom, downloads and the cursor are this computer's only (ADR-0222, consequences).
- A screen reader's reading of the download strip and the drawing editor.
