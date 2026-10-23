# Notifications on a Mac

Checked on an Apple silicon Mac on October 22, 2026: in the built app over the E2E host (`tests/e2e/desktop-notifications.spec.ts`), and against macOS itself with a throwaway Electron app. Drake Morey asked for a notification when a thread has finished everything and when one needs an answer. ADR-0112 records the decision. It is an Owl feature (`desktop-notifications`) and shows on macOS only.

## What was done in the built app

The spec launches the built app with the Owl feature on and the system notification replaced by a stand-in that records what would have been shown and lets the spec press it (`src/main/e2e/fakeNotification.ts`). Everything else is real: the router, the tracker, the notifier, Settings and the window.

- Settings has a **Notifications** group in Application with two switches, both on. Each saves (`notifyNeedsYou`, `notifyFinished`) and keeps its value across a reload. **Send a test notification** answers "Sent. If you did not see it, allow Sotto in System Settings → Notifications." and the stand-in recorded the notification titled Sotto.
- With the window on Settings, so no pane shows the thread, a question from the thread made exactly one notification, titled with the thread's title, saying "The agent is asking a question." (the E2E host's threads name no provider). A permission said "The agent is asking for permission." Neither carried the request's text. Pressing the notification showed the Threads page with that thread selected.
- A turn that ran and went idle made no notification for the first second and a half and exactly one, "The agent finished.", once the three second settle delay had passed.
- With **When a thread has finished everything** off, the same finish made nothing, and turning the switch back on did not bring it back. With the switch on again, the next finish was told once, and only that one.
- The group was captured at 1600x1000, 1280x800 and the 820x560 minimum, in dark and light, with reduced motion on. At each size the page did not scroll sideways and the group's text met 4.5:1.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/desktop-notifications/notifications-dark-1600x1000.png` | The group in dark at 1600x1000 |
| `artifacts/desktop-notifications/notifications-dark-1280x800.png` | Dark at 1280x800 |
| `artifacts/desktop-notifications/notifications-dark-820x560.png` | Dark at the minimum window |
| `artifacts/desktop-notifications/notifications-light-1600x1000.png` | Light at 1600x1000 |
| `artifacts/desktop-notifications/notifications-light-1280x800.png` | Light at 1280x800 |
| `artifacts/desktop-notifications/notifications-light-820x560.png` | Light at the minimum window: the test button's answer sits beside it, on two lines |

The "Setting saved." line at the top of some captures is the switch presses' own confirmation, not part of the group.

## What macOS did with a throwaway Electron app

Electron 43 shows notifications through macOS's UNNotification. A small Electron app, with its own bundle ID, asked for one in each of these states, and `usernoted` (the macOS notification service) was read for its answer:

| The app | What happened |
| --- | --- |
| The stock Electron from `node_modules`, run from a shell | `failed`, "UNErrorDomain error 1" |
| A copy with its own ID, ad-hoc signed, run from a temporary folder | `failed`, "Notifications are not allowed for this application"; `usernoted` logged "Failed to find or validate client" |
| The same, signed with an Apple Development identity, started with `open` | the same refusal |
| The Apple Development copy moved into `~/Applications` and registered with Launch Services | `show`; `usernoted` delivered it to Notification Center |
| An ad-hoc signed copy with a fresh ID in `~/Applications`, another app in front | `show`; macOS sent its own permission request and `usernoted` delivered the notification, presenting it "as none" |

So macOS needs to find and validate the app: the probe that worked was registered with Launch Services in `~/Applications`, the same app run from a temporary folder was refused, and an installed app in Applications is one macOS finds and validates. An ad-hoc signature was enough for that: stable Macs can show them as well as Owl. A copy run from another folder, or Electron started by `npm run dev`, is refused, and Sotto gets the `failed` event. Sotto logs `desktop-notification-failed` once, shows nothing and Settings' test says "macOS did not show it." The probe apps were removed afterwards.

## Not checked here

- A banner from Sotto's own packaged build. Its bundle ID is the installed Sotto's, and a second copy would share that app's data folder and notification identity, so none was run.
- Whether a banner shows after the user allows notifications, and whether one shows while Sotto is the app in front. The last row above was delivered "as none" before any answer to macOS's permission request.
- A Developer ID signed Owl build, and real providers: the E2E host stands in for the provider.
- Windows and Linux: the platform flag leaves them as they were, and they were not run. Design baselines were not regenerated; they are Windows captures and the group appears only on a Mac with the Owl feature on.
- On this Mac the full unit suite had four failures: `gitLauncher` (two) and `owlHost` (one), which fail on `main` here too, and `phoneAccess` "shares a pairing store already loaded", which fails about half its runs on the base commit too (four of eight when run alone there).
