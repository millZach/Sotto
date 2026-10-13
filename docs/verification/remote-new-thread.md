# A new thread on a remote host — 2026-10-05

New thread on a project that lives on forge opened its pane, but the window never selected the thread. Leaving Threads and coming back showed the empty page, and with an old coordinator draft on this computer it read "Your draft is saved. Reconnect to continue your saved draft." while everything was connected (#733). Reproducing it on `main` turned up a second fault: in 0.1.31 the same press blanks the window (#732).

## What was found

- **Against forge.** The desktop's own `DesktopHosts`, `SshHostLauncher` and `DesktopHostRouter` from 0.1.30, driven by a throwaway test against forge's running 0.1.30 host, created one thread in Space Race the way the Threads page does. The host took it in 91 ms with no error, and every state the router published afterwards still had `activeThreadId: null`. A remote host keeps a selection for each client (`peer.selectedThreadId` in `src/host/socketServer.ts`), and only `select-thread` and `select-project` move it, so the router had no move to follow. The test settled its thread and revoked its own pairing; forge's host was never stopped or configured.
- **In the built app.** Over the scripted ssh and a real headless host, the pane opened and survived until the page remounted: Dictate and back left "Choose a thread." with the new thread unselected in the sidebar.
- **The blank window.** On `main` the same press threw "This action belongs to another host…" from `CloudIphoneStore.watch`, or "This action runs on the host machine…" with this computer's host off, and React unmounted the page. The draft record the Threads page shows before main confirms the thread was not marked `remoteHost`, so the pane and the phone player watched it for cloud iPhone sessions through this computer's bridge.

## What changed

- `src/main/hosts/desktopHostRouter.ts`: when a remote host confirms a thread this window created, the router selects it and forwards `select-thread`, so the host composes and sends there too. Nothing happens on a refusal, when the window's selection moved while the host was creating, or when the host was removed meanwhile.
- `src/renderer/src/agents/newThread.ts`, `draftThreads.ts`: the draft carries `hostId`, `remoteHost` and `hostLabel` as the router will publish them.
- `src/renderer/src/tools/cloudIphoneStore.ts`: a listing the bridge refuses, thrown or rejected, reads as no sessions instead of an error.

## Automated checks

- `tests/unit/main/desktopHostRouter.test.ts`: the thread opens and the host is told; a refusal, a selection or a Next press made meanwhile, and a removed host leave the window alone; a lost or refused forward still reports the creation; the local host and a creation that names no thread are unchanged. The opening tests fail without the router change, and the Next and removed-host tests fail on its first version.
- `tests/unit/renderer/unusedNewThread.test.tsx`: a draft on forge is marked remote with its host; a draft on this computer is not. Both fail without the change.
- `tests/unit/renderer/tools/cloudIphoneStore.test.tsx`: a thrown refusal and a rejected listing both read as no sessions. The first fails without the change.
- `tests/e2e/remote-new-thread.spec.ts`: with this computer's host on and selected, New thread on the remote host's Space Race opens the thread, main selects it, and it is still open after Dictate and back, with no page errors. Built from `main`, it fails on the blank window; with only the cloud iPhone change, it fails because main never selects the thread.
