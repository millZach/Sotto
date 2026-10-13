# Add host's setup checklist and Tailscale approval (#429)

Test citations use the current split files. Recorded counts and outcomes are from the original runs.

Verified September 27, 2026, on Windows 11, in the built app under Playwright. SSH is the scripted `ssh` in `tests/fixtures/fakeSsh.mjs`, reached through a development-only seam in main (`SOTTO_E2E_SSH_SCRIPT` and `SOTTO_E2E_SSH_EXECUTABLE`, like the `gh` stand-in). The fake holds the launch command the way Tailscale SSH's `check` mode does, printing Tailscale's banner (`# Tailscale SSH requires an additional check.`, `# To authenticate, visit: https://login.tailscale.com/a/…`) and answering nothing until the spec approves. Once approved, the real launch script runs on this computer against a fake host installation: a real headless host with scripted providers (`tests/fixtures/e2eSshHost.ts`, built by the spec), which this computer pairs with over a real forward. No SSH server, no Tailscale and no browser were touched: an end-to-end run records the page Open approval page would have opened instead of opening it.

## What `tests/e2e/host-setup.spec.ts` drove

1. **Failed.** Settings > Hosts > Add host, `forge`, with the fake reporting Node 26.1.0. The form gave way to "forge · user and port from your SSH configuration" with **Change**, the title became "forge could not be added", and the steps read Reached forge (done), Signed in (done), "The host cannot run on forge yet" (failed), Start the host and Pair this computer (not started). The failure sat on its step: "The SSH host runs Node 26.1.0, which is newer than this host release supports. Nothing was saved. Install Node 24 for that SSH account, then add the host again." **Try again** was enabled (`failed-1280-dark.png`, `failed-820-light.png`). Escape closed the dialog and the page still read "No remote hosts yet."
2. **Waiting.** Add host again, with Tailscale holding the connection. The title read "Connecting to forge", the second step "Waiting for your approval in Tailscale" with the Waiting for you mark and `aria-current="step"`, and its card "forge uses Tailscale SSH, which asks you to approve new connections in your browser. Sotto waits up to 5 minutes and carries on when you approve." Focus moved to **Open approval page** by itself; **Connecting…** stayed disabled (`waiting-1600-dark.png`, `waiting-820-light.png`). Nothing had been opened until Enter pressed the button; main then took the URL it holds, checked it, and recorded `https://login.tailscale.com/a/l1fixture2b3c`.
3. **Connected.** The spec approved. With nothing else pressed, the checklist went on through Signed in, Host installed and Host started to Paired; the title became "forge is connected", the card "forge is added and connected. Its projects and threads show in the Threads sidebar with a forge badge.", and **Done** had the focus (`connected-1280-light.png`, `connected-820-dark.png`). Enter closed the dialog onto the row "SSH forge · Connected" (`row.png`). The saved-hosts file held forge and no Tailscale address.

At each of the three moments the spec set the window to 1600x1000, 1280x800 and the 820x560 minimum, in dark and in light, with reduced motion on, and checked that the dialog stayed inside the window and did not scroll sideways; at the minimum it scrolls in itself.

At every size and in both rooms the spec also measures each piece of the checklist's text against the surface it sits on, the notice cards' sunken surface included, and fails below 4.5:1. The lowest ratios it measured:

| Text | Dark | Light |
| --- | --- | --- |
| Host name in the summary line | 17.49 | 14.49 |
| "· user and port from your SSH configuration" (muted) | 8.49 | 6.18 |
| Step names, including not-started steps (muted) | 8.49 | 6.18 |
| Card sentences: the failure, the Tailscale wait, connected | 18.74 | 14.19 |
| **Why Tailscale asks** (accent text, 12.5px) | 11.99 | 6.52 |

`tests/e2e/hosts.spec.ts` still adds `127.0.0.1` on port 1 through Windows' real OpenSSH. It now finds the failure on the Reach step of "127.0.0.1 could not be added", with the `ssh -p 1 127.0.0.1` command and **Copy** (`real-ssh-failed-820-light.png`).

## What the other suites cover

- `tests/unit/main/sshFailure.test.ts`: Tailscale's banner read among Windows' DEBUG1 lines and CRLF, with and before its URL line; only `https://login.tailscale.com/` pages are kept (a look-alike host, plain http, a user or a port in front are refused); `Connection to <host> port <n> timed out` reads as `connect-timeout`, and as `tailscale-unapproved` on a connection Tailscale held; the step every failure code belongs to; the commands offered, and that none is offered where it cannot be written safely.
- `tests/integration/sshLauncher.test.ts`: the steps a real launcher reports over the fake ssh (reach, sign-in on a password question, install on the first output, start); a Tailscale hold approved after it began, with its page and the approval clearing; `ServerAliveCountMax=21` on the commands and `2` on the forward; no approval within the budget is `tailscale-unapproved`, the approval budget replacing the shorter sign-in one; OpenSSH's own timeout on a held connection; a Node too new on the installation step.
- `tests/integration/desktopHostConnections.test.ts`, `tests/integration/desktopHosts.test.ts`: the step, the approval page and the fix reach the dialog's state; Open approval page opens the page only while it waits and only Tailscale's own; a failure lands on its step; `tailscale-unapproved` stops a saved host's retries; the dialog's sentence for it says nothing was saved.
- `tests/unit/renderer/features/settings/addHost.test.tsx`, `tests/unit/renderer/features/settings/hostRows.test.tsx`: the dialog's three states, the keyboard path (focus to Cancel, to Open approval page, to Done; Escape cancels), Copy, Try again, Change, a refusal before connecting going back to the form, and a saved host's row while Tailscale waits.

After review, the same suites also cover: an Open approval page press that fails staying on the Tailscale card and leaving the failed step to main's sentence; a port forward Tailscale holds, shown on the Tailscale step with its 30 seconds, failing with a sentence that says so, and, once approved, dropping later as a dropped connection; a request sent to a connected host keeping `ServerAliveCountMax=2` and saying to switch the host off and on when Tailscale holds it; the hidden status line that says which step is in progress and that a command was copied; and the saved identity file in the `ssh` command a failure offers.

## Not checked live

Adding forge itself was not repeated: its approval needs the owner's browser and Tailscale sign-in. What the fake prints is what the owner's `ssh.exe` printed on September 27, and the 30-second end is OpenSSH's own read timeout, `ServerAliveInterval` x `ServerAliveCountMax`, which the commands now set to 15 x 21. Still to do with the owner: add forge with Tailscale SSH in `check` mode, approve within 5 minutes, and see it reach Paired; and on the Apple silicon Mac, that `LogLevel=INFO` shows Tailscale's banner there as DEBUG1 does on Windows.

Captures are in `artifacts/host-tailscale-approval/`.
