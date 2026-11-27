# What T3 Code's browser does that Sotto's did not

November 27, 2026. Rez asked that Sotto's browser do everything T3 Code's does. This note compares the two, feature by feature, as the ground for [ADR-0220](../adr/0220-sottos-browser-does-what-t3-codes-does.md) and [ADR-0221](../adr/0221-browser-profiles-keep-the-users-sign-ins.md), and records what was built and what was not, with the reason.

## What was read

- T3 Code's agent tools for its browser, as an agent sees them: `preview_open`, `preview_navigate`, `preview_act`, `preview_snapshot`, `preview_status`, `preview_wait_for`, `preview_evaluate`, `preview_dialog`, `preview_resize`, `preview_set_appearance`, `preview_recording_start` and `preview_recording_stop`, `t3_preview_list` and `t3_preview_close`.
- T3 Code's source, read only: the desktop preview manager (`apps/desktop/src/preview/Manager.ts`), the web preview components (`apps/web/src/components/preview/`), the browser profile and import contracts (`packages/contracts/src/browserProfile.ts`, `browserImport.ts`) and the user guide's `docs/user/browser-import.md`.
- Sotto at `origin/main` (9220d0129): `src/shared/browser.ts`, `src/main/tools/browser*.ts`, `pageAutomation.ts`, the pane and player, and ADR-0029, ADR-0154 and ADR-0198.

## The comparison

**Has** means Sotto does it now as T3 Code does, or in Sotto's own way to the same end. **Partial** means part of it, with what is missing said in the notes. **Missing** means Sotto does not do it. "Before" is `origin/main`; "now" is this branch with `browser-parity` on.

### What an agent can do

| Capability | T3 Code | Before | Now | Notes |
| --- | --- | --- | --- | --- |
| Open a page by address | `preview_open` `url` | Has | Has | `browser_open`. |
| Open a server on this computer by port | `target: environment-port` | Missing | Has | `browser_open` takes `port`, `path` and `protocol`. |
| Open a page without bringing it forward | `open: false` | Missing | Has | `background: true`; the pane lists it and does not switch to it. |
| Navigate and wait for a stage | `readiness` load, domContentLoaded, none; `timeoutMs` | Partial | Has | `navigate` takes `waitUntil` and `timeoutMs`; before, it waited for load only. |
| List the thread's pages | `t3_preview_list`, `preview_status` `tabs` | Has | Has | `browser_pages`; a page not shared shows only its ID. |
| Close a page | `t3_preview_close` | Missing | Has | `browser_close`, for pages the agent opened; the user's stay open. |
| Page state: address, title, loading, viewport, a waiting dialog | `preview_status` | Partial | Has | `browser_status` and `browser_pages`; the page now carries its dialog, colour scheme, recording and whether the user is using it. |
| Read the page as an accessibility tree with refs | `preview_snapshot` with `aria-ref` | Missing | Has | `snapshot`: roles, names, values, states and a ref on each element, the page's visible words, its console messages and errors, and a picture with `includeImage`. |
| Screenshot, kept as a file | `preview_snapshot` `save` | Partial | Has | `screenshot` returned a picture only; `save: true` keeps a PNG and returns its path, `fullPage: true` takes the whole page. |
| Click by ref, selector or point; right, middle; double, triple; modifiers | `preview_act` click | Partial | Has | Before: a left click at a point. |
| Type, into the focused field or one by ref or selector; replace | `preview_act` type, `clear` | Partial | Has | Before: the focused field only. `secretRef` types a saved secret (ADR-0219), which T3 Code does through its secret tools. |
| Hover | `preview_act` hover | Missing | Has | |
| Choose in a native select | `preview_act` select | Missing | Has | By value or label. |
| Drag one element onto another | `preview_act` drag | Missing | Has | |
| Give a page files | `preview_act` upload, file chooser or input | Missing | Has | Files from the thread's folder or Sotto's browser files; always asks the user (ADR-0220, decision 5). |
| Press a key with modifiers | `preview_act` press | Partial | Has | Before: Enter, Backspace, Tab, Escape and arrows, no modifiers. Now named keys, F-keys, one character, and Alt, Control, Meta, Shift, with macOS editing commands. |
| Scroll the page or one container | `preview_act` scroll with a locator | Partial | Has | Before: a wheel at a point. A container by ref or selector now moves directly, so it works however the pane draws the page. |
| Wait for an element, words or an address | `preview_wait_for` | Missing | Has | `wait_for`, and `hidden: true` waits for it to go. |
| Run JavaScript and read its value | `preview_evaluate`, 64 KB | Missing | Has | 64 KB; masked; off on a page holding a secret the user saved (decision 6). |
| Answer an alert, confirm or prompt | `preview_dialog` | Missing | Partial | Alert, confirm and leave-page are answered on both kinds of page. A `prompt()` on this computer is cancelled by Electron before Sotto sees it, so it reaches neither the user nor the agent; on a paired host's Chromium it works. T3 Code's own tool says desktop hosts may not support it. |
| Record the page to a video | `preview_recording_start`, `preview_recording_stop` | Missing | Partial | Has on this computer: WebM, stops itself at 50 MB, kept a week. Not on a paired host (see below). |
| Size: fill, freeform, device presets with orientation | `preview_resize`, 17 presets | Partial | Has | Before: freeform sizes. Now T3 Code's 17 presets, portrait or landscape, and fill. |
| Colour scheme | `preview_set_appearance` | Missing | Has | `appearance` light, dark, no-preference or auto. |
| Choose a signed-in profile | `preview_open` `profileId` | Missing | Missing, by design | Rez's rule: using a signed-in profile is the user's action, never an agent's. ADR-0221. |

### What the user sees and does

| Capability | T3 Code | Before | Now | Notes |
| --- | --- | --- | --- | --- |
| The page's dialog, answered by the user | In the preview | Missing | Has | A card at the page's foot: the page's words, OK and Cancel, Leave and Stay, a prompt's field. |
| Local servers offered with no page open | `PreviewLocalServerCard` | Missing | Has | Only servers started from Sotto, by a terminal or an agent (decision 4). |
| Recent addresses with no page open | `PreviewRecentUrlCard` | Has | Has | **Opened this session**. |
| Recording shown, with Stop | In the preview | Missing | Has | "Recording this page · 0:12" with **Stop**, which keeps the video. |
| Device presets and colour scheme from the menu | `PreviewMoreMenu` | Partial | Has | More lists eight presets, Rotate, and the page's colour scheme. |
| Who has the page; the agent waits while a person is in control | Tab owner, human in control | Partial | Has | **Take over** and **Hand back**; the user's own click, key or wheel holds the agent for a moment (decision 8). |
| A floating player | `ThreadPreviewMiniPlayer`, picture-in-picture | Has | Has | Sotto's **browser player** and **Float the browser over the thread**. |
| Point at an element and tell the agent | Annotation | Partial | Partial | Sotto's **Point at something** sends an element and a comment. T3 Code's annotation also draws on the page and takes speech; not built (below). |
| Profiles that keep sign-ins | Default (kept), Incognito, named profiles | Missing | Has | Sotto's pages kept nothing between runs. Now the user adds named profiles that keep sign-ins; **A fresh page** keeps nothing, as Incognito. ADR-0221. |
| Copy sign-ins from another browser | Import wizard | Missing | Partial | Firefox and Zen, on Windows, macOS and Linux. Not Chromium browsers or Safari (below). |
| Developer tools | `openDevTools` | Missing | Has | **Open developer tools** in More, in a window of their own; the user's only. |
| Page zoom | `ZoomIndicator`, zoom keys | Missing | Missing | Below. |
| Downloads | Allowed, placed by the user | Missing | Missing | Below. |
| Passkeys | A bridge to the system's passkeys | Missing | Missing | Below. |
| An agent's cursor drawn where it acts | `AgentBrowserCursor` | Missing | Missing | Below. |

### On a paired host

A paired host's thread browses in the host's own Chromium (ADR-0198). The full catalog runs there through the same page automation, so every action above works there too, with these exceptions: recording, the local-server list, developer tools and profiles are this computer's only, each refused in words.

### Antigravity

Antigravity threads keep the stable catalog. `agy` drops a session's largest tool, without saying so, once its tool declarations pass about 58 KB, and an ordinary thread is near that already (ADR-0219, decision 2). The full catalog's descriptions would cost Antigravity its `delegate`. Its threads ask for the catalog compact and get the stable one (decision 3).

## Not built, and why

- **`prompt()` on this computer.** Electron's `WebContentsView` cancels `window.prompt()` and returns null before the page's debugger hears of it, so Sotto has no dialog to show or to answer. Building it means Electron's own change. A paired host's Chromium answers prompts.
- **Recording on a paired host.** This computer records from the page's screencast in a hidden window with the browser's own encoder. A host has no window and Sotto ships no video encoder, so recording there needs an encoder on the host, which is a new dependency and its own ADR, or a page on the host that encodes, which the host has no place for yet.
- **Copying sign-ins from Chrome, Edge, Brave, Arc, Opera, Vivaldi and Helium, and from Safari.** On Windows, current Chromium browsers seal cookies with app-bound encryption, which only the browser itself can open; T3 Code cannot import them either, and imports only Helium among Chromium browsers there, whose cookies use the older per-user encryption. On macOS and Linux they need the browser's key from the Keychain or the Secret Service, and Safari's cookies need Full Disk Access. Those paths decrypt the user's credentials and could not be verified from this Windows computer, and an unverified decryptor of someone's sign-ins is the wrong thing to ship. Firefox and Zen keep cookies unencrypted in a database Sotto reads with Node's own `node:sqlite`, on all three platforms.
- **An agent choosing a profile.** By Rez's rule: a signed-in profile is the user's to use. An agent's own pages open in the thread's session, which keeps nothing; a page in a profile starts private, and the agent sees it only once the user shares it.
- **Profiles on a paired host.** A host's Chromium runs with a temporary profile deleted when it closes (ADR-0198). Keeping sign-ins there, or carrying them over the host connection, is a decision of its own.
- **Page zoom.** Zoom changes the scale between CSS pixels and the screen, which every coordinate an agent gives, the emulated sizes and the presets rely on. The pane's sizes and presets cover how a page looks at another size; zoom waits for a design that keeps agent coordinates exact.
- **Downloads.** Sotto's browser blocks them and says to open the page in the system browser. Letting a page write to the user's disk, and deciding whether an agent may read what it wrote, is a permission decision of its own.
- **Passkeys.** T3 Code bridges a page's WebAuthn requests to the system's authenticator through its own preload. In Sotto the page has no preload by design (untrusted pages have no bridge to Sotto), so a passkey bridge needs its own security review.
- **Drawing and speech on the page.** **Point at something** already sends an element with a comment. Drawing would put Sotto's script into the page under test, which Point avoids, and speech would add a recording path to the browser.
- **An agent's cursor.** Each action is a step with a picture in Tools and the player. Drawing a cursor over the native page needs either Sotto's script in the page or a window over it.
