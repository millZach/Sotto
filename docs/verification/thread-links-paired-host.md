# Links in a paired host's thread

November 3, 2026. No ADR decides this. It follows what the code already says: a thread with no folder for Sotto's browser opens its links in the system browser (`threadLinkRouter` in `webLinks.tsx`, and the question page route in `src/main/index.ts`), and a paired host's Browser tool is on the host (`ToolsPanel.tsx`). Zach chose this over building a Sotto browser for a paired host's threads, on November 3, with his own setting on Sotto browser.

## What was exercised

The installed Sotto Owl 0.1.43-owl.20261103.1 on the Windows laptop, with **Web links in threads** set to Sotto browser and forge as the paired host, pressed with real mouse input before the fix. The same build, in a second copy with its own profile, for direct calls on `window.sotto`. The fix itself, in the app `npm run build` makes, on Windows under Playwright with a real headless host on a real socket, with only `shell.openExternal` recorded.

## What it showed

| Thread | Link | Installed Owl, before the fix | With the fix |
| --- | --- | --- | --- |
| Laptop | Public, `example.com` | Opened in Sotto's browser | Not changed by the fix |
| Laptop | Tailnet, `forge.tail5728ca.ts.net` | Opened in Sotto's browser | Not changed by the fix |
| Forge | Tailnet, `forge.tail5728ca.ts.net` | "Could not open forge.tail5728ca.ts.net." with Copy link | Goes to the system browser, on a stand-in host |
| Forge | Public | Not pressed: no forge thread at hand held one | Goes to the system browser, on a stand-in host |

So the host decides, not the address. In that build `window.sotto.browser.list` for a paired host's thread throws "This action belongs to another host" before it returns a promise, while `window.sotto.files.list` for the same thread returns one. On the laptop thread, **Open in system browser** opened the tailnet page in the system browser, which is the path a forge thread's links now take.

With the fix removed, `tests/e2e/remote-thread-links.spec.ts` fails at the first press, and three of the four new tests under "in a thread on a paired host" in `browserSurface.test.tsx` fail. The fourth, Copy link after a real failure, passes either way.

## Not proved

The fix has not been pressed in a real forge thread: that needs an Owl built with it. The journey's stand-in host draws its links from a thought's text, because its replies do not reach a paired window; the thought uses the same `MessageContent` under the same `ThreadWebLinks` as a reply. Packaged macOS and Linux were not pressed.

## Screenshots

- `artifacts/thread-links-paired-host/installed-owl-forge-thread-failure.png`: the failure in the installed Owl.
- `artifacts/thread-links-paired-host/remote-thread-links-opened.png`: both links opened with the fix, no error.
- `artifacts/thread-links-paired-host/remote-thread-links-failed.png`: a browser that really fails still offers Copy link.
