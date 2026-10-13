# Hyprland paste after different keyboards

October 11, 2026. Source research for `fix/linux-paste-any-keyboard`. This note describes implementation behavior and candidates; it makes no claim of end-to-end paste verification. The running-app evidence belongs in [the verification note](../verification/linux-hyprland-paste.md).

The live Quickshell process supplied the session environment for the read-only `hyprctl version -j` query. Forge reported Hyprland **0.56.2**, clean tag `v0.56.2`, commit **`efb50993780079460b0cbed1363e2166a2de1d9f`**. All Hyprland source links below pin that revision. `pacman -Q` reported `wtype 0.4-2` and `ydotool 1.0.4-2`; wtype's official `v0.4` tag points to `d71be3a7b3f93b534a2823fd68cabd7ac2a02359`.

## Why the two Lua dispatchers share the problem

Both `dsp_sendShortcut` and `dsp_sendKeyState` call the same `resolveKeycode`. A `code:N` string returns N directly. A named key instead searches the seat's active keyboard keymap in its current group, with depressed modifiers cleared. An absent symbol returns an error. Neither dispatcher chooses another keyboard. The source therefore supports the reported failure after a minimal virtual keymap, and rules out changing only the dispatcher name as a solution. [LuaBindingsDispatchers.cpp, lines 353–439](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/config/lua/bindings/LuaBindingsDispatchers.cpp#L353-L439).

The documented Lua spelling is `hl.dsp.send_shortcut({ mods, key, window? })`; `send_key_state` adds a state field. A dispatcher is passed to `hl.dispatch` to execute it. The docs do not promise a keymap change. [Hyprland 0.56 dispatchers](https://wiki.hypr.land/0.56.0/Configuring/Basics/Dispatchers/#general).

These are the exact diagnostic candidates, **not recommended fixes by themselves**:

```lua
hl.dispatch(hl.dsp.send_shortcut({ mods = "CTRL", key = "V" }))
hl.dispatch(hl.dsp.send_key_state({ mods = "CTRL", key = "code:55", state = "down" }))
hl.dispatch(hl.dsp.send_key_state({ mods = "CTRL", key = "code:55", state = "up" }))
```

`Actions::pass` sends the requested modifiers and keycode minus eight directly to the focused client. It does not replace the client's keymap. `sendKeyState` changes only whether `pass` emits a press or release. Thus acceptance of `code:55` proves dispatch acceptance, not that an application interpreted Ctrl+V. Hard-coded codes also carry layout assumptions. [ConfigActions.cpp, lines 1530–1617](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/config/shared/actions/ConfigActions.cpp#L1530-L1617).

## What actually changes the client's keymap

A keyboard's normal key or modifier event makes that device the seat keyboard before its event is forwarded. Creating a device also selects it. Destroying a device chooses the last remaining keyboard in the device list, which need not be a full keyboard. [InputManager.cpp, lines 1193–1203](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/managers/input/InputManager.cpp#L1193-L1203), [1539–1555](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/managers/input/InputManager.cpp#L1539-L1555), [1677–1719](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/managers/input/InputManager.cpp#L1677-L1719).

Selecting a different seat keyboard calls `updateActiveKeyboardData`, including the seat protocol's keymap update. That protocol sends the selected keyboard's serialized keymap to client keyboard resources. This is why activating a suitable keyboard addresses client interpretation as well as name resolution. [SeatManager.cpp, lines 161–179](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/managers/SeatManager.cpp#L161-L179), [Seat.cpp, lines 366–384 and 594–600](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/protocols/core/Seat.cpp#L366-L384).

`switchxkblayout` changes a device's layout group; it does not directly select the device. [HyprCtl.cpp, lines 1359–1431](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/debug/HyprCtl.cpp#L1359-L1431). Setting the existing group emits no modifier event, so it cannot reliably activate a keyboard with only one layout. [IKeyboard.cpp, lines 375–414](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/devices/IKeyboard.cpp#L375-L414).

No direct keyboard-selection or client-keymap override API appeared in the inspected Lua registration lists: [top-level bindings, lines 530–553](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/config/lua/bindings/LuaBindingsToplevel.cpp#L530-L553), [query bindings, lines 392–408](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/config/lua/bindings/LuaBindingsQuery.cpp#L392-L408). This is a bounded source-search finding, not a claim about every future or plugin API.

## Candidate comparison and recommendation

| Candidate | Source-based assessment | Remaining proof |
| --- | --- | --- |
| `send_key_state` with key names | Resolves against the active device. | Known reported failure after a minimal keymap. |
| `send_key_state` with `code:N` | Bypasses name lookup but leaves client interpretation dependent on its keymap. | Exact received text in both targets after both keyboard types. |
| Lua `send_shortcut` | Shares both resolver and delivery path with `send_key_state`. | No reason from source to expect independence from the active keymap. |
| Activate a full keyboard, then dispatch | Selecting that device publishes its keymap to clients. | Requires an available suitable device and a reliable activation event. |
| Send the chord through a temporary virtual keyboard with its own matching keymap | Owns both the symbol mapping and events for that paste. | Exact text and cleanup in the four requested cases. |

**Recommended candidate if the keycode proof fails:** send the existing paste chord through `wtype`, using fixed arguments and a 50 ms key hold:

```sh
wtype -M ctrl -P v -s 50 -p v -m ctrl
wtype -M shift -P Insert -s 50 -p Insert -m shift
```

wtype's flags specify modifier and key presses/releases and pauses. [Official wtype README](https://github.com/atx/wtype/blob/d71be3a7b3f93b534a2823fd68cabd7ac2a02359/README.md#usage). It allocates its keycodes from the requested symbols, uploads a matching keymap before running the command sequence, and performs Wayland round trips after individual modifier/key events. It destroys its virtual keyboard at the end. These facts explain why its own paste chord can be independent of another keyboard's minimal map, even though `wtype x` itself supplies a minimal map. [wtype main.c, lines 265–272, 318–342, 452–548](https://github.com/atx/wtype/blob/d71be3a7b3f93b534a2823fd68cabd7ac2a02359/main.c#L452-L548).

Hyprland accepts a virtual keyboard's supplied map and marks it overridden, rather than applying the configured physical layout to it. [VirtualKeyboard.cpp, lines 37–44](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/devices/VirtualKeyboard.cpp#L37-L44). That supplies the needed client mapping without changing the user's physical keyboard configuration. A small virtual keyboard map containing the complete paste chord is sufficient; a full physical map is unnecessary.

Keep modifier-release polling, both lock checks, focused-target validation, terminal detection, PRIMARY writing, and copy fallback around whichever candidate passes the live proof. A successful dispatcher reply alone is not an application-level assertion. No pure Lua invocation inspected here supplies an independent mapping by itself.

Choosing wtype would add a Linux command prerequisite, so amend Linux install documentation/package dependencies and [ADR-0062](../adr/0062-the-desktop-app-runs-on-linux-omarchy-first.md), whose output paragraph currently specifies one Hyprland request. It adds no npm production dependency. If wtype is unavailable or dispatch fails, keep the completed transcript copied and report the existing copied result.
