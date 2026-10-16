# The window opens on a starting screen while providers and hosts connect

## Status

Accepted October 15, 2026. For about ten seconds after Sotto launches on the development machine, the window showed the Threads page, painted from the last run's cached shell, while Claude Code, Codex, Grok Build, Devin and the saved host `forge` connected. The page looked ready and was not: threads read as disconnected and sends waited. Zach asked for that time to be covered by a starting screen. From an HTML prototype of three variants, In the room (the window as it will be, threads dimmed, one quiet block listing what is connecting), Whole window (the drag strip and one centred line with a dot per provider and host) and Checklist (a locked sidebar beside a short log in plain words), he chose Whole window. It is not an Owl feature (ADR-0072) and goes straight to stable.

## Decision

At launch, once first-run setup is finished, the window shows the **starting screen** in place of the app. It sits under the window's strip, which still drags and keeps the window controls, and shows only the Sotto mark, one centred line naming what Sotto is doing now ("Loading your threads", "Connecting Codex", "Waiting for forge"), and a row with a dot and the name of each provider and host it waits for. An accent dot is ready, a muted breathing dot is connecting, and an attention dot has not answered. The line is a `role="status"` live region. Nothing on the screen is focusable until the late button appears. Colour comes from theme roles. With reduced motion the dot holds still.

The screen holds while anything it watches is connecting. It watches this computer's providers, read from the local host's entry in the window's agent state (`connections` and `host.clientHosts`), and every saved host that is switched on, read from the hosts state the window already receives. A remote host counts as one item, connected or not. Its own providers are the host's business. No main-side state or channel was added: everything the screen needs reaches the window already.

**Settled** means connected, or an answer that it will not connect now. For a provider, settled is `connected`, `error` (not installed, too old, signed out, cannot start, or any refusal) or `disconnected` (turned off or never asked). Only `connecting` holds. For a saved host, settled is `connected`, `error`, `disconnected` or switched off. So is a host that is `connecting` but waiting on the user, with SSH's question or a Tailscale approval: Sotto is waiting for the user, not for the host. The host question dialog is asked over the starting screen as it is over any page. A `connecting` host, including one reconnecting after a failed first try, holds. A provider the screen saw connecting that then failed keeps its dot without a colour. A failure from before the window opened has no dot.

Until main answers for the agent state, the line says "Loading your threads". The last run's cached shell does not count as an answer. The screen keeps its words back for the first 200 ms, so a launch with nothing to wait for opens the app without the screen saying anything.

If anything still holds after ten seconds, the screen adds one line, "forge has not answered in 10 seconds. Sotto keeps trying in the background." ("have" for more than one name, listed as "Codex, Devin and forge"), and a button, **Open Sotto without forge**, which takes keyboard focus as it appears and is described by that line. Pressing it opens the app. What it names keeps connecting in the background, exactly as it does today. A source main never answered for counts as empty at ten seconds.

When everything has settled, or the button is pressed, the app replaces the screen in one step: the column fades for 200 ms and the app takes the window. With reduced motion, or when no words had shown, there is no fade.

The screen is for launch only. It decides once, when settings load. First-run setup, a window whose agent bridge is missing, and a window that has already opened the app all go straight to the app. The last of these is remembered in the window's session storage, so a reload of the renderer opens the app at once. Reopening the window from the tray shows the renderer that is already open. A window main has to make again, after its renderer crashed, decides afresh, but everything has connected by then, so it settles on main's first answer inside the 200 ms in which it says nothing. Once the app is open, nothing that disconnects later brings the screen back. A launch with no provider enabled and no host saved settles on main's first answer and never shows it. Neither does first-run setup, which behaves as before. Finishing setup in the same window opens Threads with the Threads tour, as before.

End-to-end runs show the screen only when the spec launches with `SOTTO_E2E_STARTING_SCREEN=1` (exposed as `window.sottoE2E.startingScreen`). Every other journey and every design capture opens straight onto the app, so none of them waits behind it and no baseline changes. `tests/e2e/starting-screen.spec.ts` asks for it.

## Relation to issue #995

[#995](https://github.com/millZach/Sotto/issues/995) asks for the window to appear sooner at launch. This decision is about what the window shows once it appears, and changes nothing about when. Main still shows the window once the main and widget renderers have loaded. The starting screen is what #995's "the renderer's first calls wait for readiness without painting misleading empty states" asks for. When #995 moves the window earlier, the window will show the starting screen sooner, rather than a Threads page that cannot be used yet.

## Considered Options

- **In the room.** The app's layout appeared at once, with the sidebar dimmed and the list in the middle of the room. Zach chose the calmer whole-window screen over a page that looks almost usable.
- **Checklist.** A log line for each provider and host as it answers is more to read for something that lasts a few seconds, and the locked sidebar invites presses it refuses.
- **Holding the window back until everything connects.** A window that takes ten seconds to appear reads as a launch that failed. The screen shows at once and says why it waits.
- **Main-side readiness.** Main could publish a single "ready" flag. The window already receives every provider's and host's state, and a flag would hide which one is slow, which is what the screen exists to say.

## Consequences

- The last run's cached shell no longer shows at launch behind a page that cannot be used yet. It still paints the Threads page on the first frame after a reload, and on a launch with nothing to wait for.
- A provider or host that is slow, but not broken, now holds the window for up to ten seconds before the user can open without it. A broken one, or one that needs an answer from the user, does not.
- Global shortcuts the app registers on its pages, such as New thread, do not exist until the app opens. The dictation hotkey belongs to main and works throughout.
- The `starting-screen` artifacts and `docs/verification/starting-screen.md` record the screen at 1280x800 and 820x560 in both modes, connecting and late.
