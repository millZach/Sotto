# Linux shutdown drain in Electron 43

October 12, 2026. Primary-source research for [#871](https://github.com/millZach/Sotto/issues/871), pinned to Sotto's Electron **v43.1.0**. This note distinguishes source behavior from a proposed proof; it does not claim a host shutdown was tested.

## Verified Electron behavior

Linux connects to `org.freedesktop.login1.Manager` on `/org/freedesktop/login1` through the system bus. `PrepareForShutdown(true)` invokes its shutdown callback. That path **does not call `app.quit()`**. With no callback, or an unprevented event, it closes its shutdown inhibitor FD. A prevented event retains the FD. `PrepareForShutdown(false)` does nothing; there is no automatic rearming after cancellation. Removing the callback closes a retained FD. [PowerObserverLinux, v43.1.0, lines 31–58 and 86–161](https://github.com/electron/electron/blob/v43.1.0/shell/browser/lib/power_observer_linux.cc#L86-L161).

The inhibitor is acquired **when the native shutdown handler is registered**, through `Inhibit("shutdown", executableName, reason, "delay")`; `preventDefault()` retains that already acquired lock rather than taking a new one. Registration/release is controlled by whether the JavaScript emitter has shutdown listeners. [Native handler](https://github.com/electron/electron/blob/v43.1.0/shell/browser/lib/power_observer_linux.cc#L86-L128), [JavaScript wrapper](https://github.com/electron/electron/blob/v43.1.0/lib/browser/api/power-monitor.ts#L9-L34).

`ShouldShutdown()` returns the inverse of the emitted event's default-prevented state, as returned by the event-emitter helper. Electron's API docs instruct a prevented shutdown handler to exit promptly through something such as `app.quit()`. [PowerMonitor](https://github.com/electron/electron/blob/v43.1.0/shell/browser/api/electron_api_power_monitor.cc#L89-L91), [event emitter](https://github.com/electron/electron/blob/v43.1.0/shell/common/gin_helper/event_emitter.h#L23-L39), [pinned API docs](https://github.com/electron/electron/blob/v43.1.0/docs/api/power-monitor.md#event-shutdown-linux-macos).

**Initialization concern, inferred from source:** the wrapper creates its native singleton in the first `newListener` callback, then reads `listenerCount('shutdown')` before that listener is added. Its later shutdown hook is installed inside that callback. If shutdown is the first listener, it appears to miss enabling the native shutdown handler. Node emits `newListener` before adding the listener. Electron's own Linux test first adds a dummy event listener, so it does not test this case. The real proof must observe shutdown inhibitor acquisition using Sotto's actual first-listener registration, without silently warming the monitor in the fixture. [Wrapper](https://github.com/electron/electron/blob/v43.1.0/lib/browser/api/power-monitor.ts#L12-L34), [Node event registration](https://github.com/nodejs/node/blob/v24.11.0/lib/events.js#L542-L570), [Electron's test](https://github.com/electron/electron/blob/v43.1.0/spec/api-power-monitor-spec.ts#L55-L64).

## Verified logind deadline

`PrepareForShutdown(true)` starts preparation for reboot/poweroff. Applications should finish the work and release their delay locks. `Inhibit` returns a Unix FD, and closing every duplicate releases the lock; process exit also releases it. Waiting for the signal without a previously acquired delay lock is racy. [login1 interface](https://github.com/systemd/systemd/blob/v258/man/org.freedesktop.login1.xml#L677-L730), [systemd inhibitor documentation](https://systemd.io/INHIBITOR_LOCKS/).

`InhibitDelayMaxSec` defaults to **5 seconds**. Its configured value is exposed as the microsecond property `InhibitDelayMaxUSec`. Once the deadline expires, logind ignores a still-held delay lock and proceeds. It does not grant a new allowance per listener or notify Electron to extend its timeout. The source starts one relative timer, then executes the operation despite remaining inhibitors. [logind configuration](https://github.com/systemd/systemd/blob/v258/man/logind.conf.xml#L160-L167), [property definition](https://github.com/systemd/systemd/blob/v258/man/org.freedesktop.login1.xml#L733-L747), [deadline implementation](https://github.com/systemd/systemd/blob/v258/src/login/logind-dbus.c#L1889-L2004).

Forge's read-only property query on this date returned `t 15000000`, **15 seconds**, rather than the default:

```sh
busctl --system get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager InhibitDelayMaxUSec
```

Inference: after expiry, shutdown can terminate Sotto and its local provider children before the drain settles. Outstanding writes and the latest output are not guaranteed saved; a remote provider might continue independently. Expiry itself is not a guarantee that a thread is killed at exactly five seconds.

## Existing drain and safest order

At the branch's starting revision, [quitDrain.ts](../../src/main/app/quitDrain.ts) only marks `systemEnding` on shutdown. It starts the drain on a later `before-quit` and immediately allows that system quit. Passing Linux `powerMonitor` alone therefore supplies neither an explicit quit nor a delayed drain. The brief's statement that `preventDefault` takes the inhibitor is also imprecise: it keeps the preexisting inhibitor.

The ordinary quit limit is ten seconds. [hostQuitDrain.ts](../../src/main/app/hostQuitDrain.ts) first awaits phone access, then host setup, before closing local providers. [PhoneAccessService.close](../../src/main/phones/phoneAccess.ts) allows eight seconds for its cleanup; [runtime.close](../../src/main/agents/runtime.ts) additionally awaits a worktree sweep and babysitting before stopping providers. [WorktreeCleanup](../../src/main/agents/worktreeCleanup.ts) can await a GitHub child with a thirty-second limit. There is no aggregate guarantee under the default five seconds.

Recommendation: Linux should synchronously prevent the shutdown event, start cancellation and accepted-write persistence immediately, then explicitly finish quitting. Do not let phone/network cleanup or a worktree sweep consume the whole window before provider stop begins. Preserve phone-access removal before final remote-host teardown and preserve Windows/macOS ordering and behavior. On Linux, begin local cancellation and persistence while phone cleanup runs, retaining the local stores until a sweep already running can finish. A Linux-specific early stop phase can run alongside the existing ordered final drain. Document this as best effort under logind's configured deadline.

## Safe real-Electron proof design

The installed `dbus-daemon`, Python `dbus`/`gi`, and Hyprland make the proof feasible without installing a dependency. Electron's own Linux spec uses a fake bus selected by `DBUS_SYSTEM_BUS_ADDRESS`. [Electron test setup](https://github.com/electron/electron/blob/v43.1.0/spec/api-power-monitor-spec.ts#L1-L26).

Use an owned private Unix bus with a minimal configuration that enables no activation directories or systemd activation. Keep its socket, fixture files, isolated app data and evidence inside the worktree's ignored `.cache/`. Set both bus-address variables only on the Electron proof child, launched through `scripts/with-nested-hyprland.mjs`; that helper otherwise restores the real session bus. A private bus can listen at a specified address and run in the foreground. [dbus-daemon options and configuration](https://dbus.freedesktop.org/doc/dbus-daemon.1.html).

The fake service owns `org.freedesktop.login1`, implements `Manager.Inhibit` with signature `ssss → h`, and returns a pipe write FD through `dbus.types.UnixFd`. It retains only the read side after transmission. Emit `PrepareForShutdown(true)` only on this bus after observing the shutdown inhibitor call. Check that the read side has no EOF while a controlled drain is pending, then observes EOF when Electron completes its quit. Account for transport duplicates before asserting release. Repeat with a pending drain and a synthetic deadline that records expiry without performing any system action. This proves native signal delivery and FD lifetime, not actual shutdown termination.

Use Sotto's production registration and drain code in the Electron child. Include a control with no prevention to show immediate FD release, and assert that registration acquires a shutdown inhibitor when shutdown is the first power-monitor listener. Keep all fixture service methods inert; provide no power-management methods. Capture stable timestamps/counts only, never transcripts, prompts, keys or provider protocol data. Clean up owned PIDs and preserve the live compositor. No real shutdown, reboot, suspend, log out or host service change is needed.
