# Page-opening grant, focused-thread previews and the preview switch (#232)

Checked on September 22, 2026, on Windows, in the built app driven by `tests/e2e/agent-browser.spec.ts` against a local page server. Agent calls go through the e2e bridge into the same browser agent tools a provider reaches; answers are pressed in Tools the way a user presses them. The captures are in `artifacts/browser-grant/`. The native page is drawn by main over the window, so a renderer capture shows the pane dark where the page sits.

## The answer for the whole thread

- `request-card.png`: an agent's first request to open a page offers **Allow once**, **Allow this thread to open pages** and **Deny**, in that order.
- `request-card-820x560-light.png`: at the minimum window, in light, the three answers stay inside the panel and the window does not scroll sideways.
- `grant-line.png` and `grant-line-820x560-light.png`: after **Allow this thread to open pages** the page opens shared (**Stop sharing** shows), and Tools > Browser says *This thread may open pages without asking · Stop*.
- The thread's next `browser_open` returned at once with no pending request, and a `navigate` on its shared page did too. A `click` on the same thread still waited in Tools, and its card offered only **Allow once** and **Deny**.
- **Stop** took the line away, moved focus to the address field, and the thread's next open waited for an answer again.

## Previews

- `focused-thread-preview.png`: with Workshop focused and a request from Docs waiting, the corner shows Workshop's task and nothing of Docs'.
- `settings-switch.png`: **Show browser previews** under Settings > Application, turned off, with the description naming the focused thread and the thread Tools is pinned to; the setting read back as `false` from main.
- `previews-off-tools.png`: with previews off, a new request from Workshop showed no corner preview. The Tools icon in Workshop's pane carried its dot and described "A browser request is waiting for your answer" before Tools opened. In Tools > Browser the page's tab carried a dot and "waiting for your answer", and the request card was on that page.

`verification.json` records the run. No renderer errors were reported.

## Not checked here

- A real provider's model turn using the grant. The integration test (`tests/integration/browserPageOpening.test.ts`) drives the tools over the thread's authenticated loopback endpoint with a real `BrowserService`, but its pages are mocked Electron views.
- macOS.
- The grant ending with a thread Sotto stops listing is covered by `tests/unit/main/browserTools.test.ts`; the e2e fixture has no way to remove a thread.
