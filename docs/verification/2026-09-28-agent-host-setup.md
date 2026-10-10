# Have my agent set this up (#431)

October 9, 2026: Voice control and thread management described below are historical under [ADR-0067](../adr/0067-remove-voice-control-and-thread-management.md); the original plan or evidence is retained.

Verified September 28, 2026, on Windows 11, in the built app under Playwright. The provider is the scripted agent host (`src/main/e2e/agentEffects.ts`), which runs a real thread on the real coordinator but calls no tools, so the spec calls the thread's `sotto_host_setup` tools through the end-to-end bridge (`window.sottoE2E.hostSetupTool`), which reaches the same tool server the providers' launch arguments point at. SSH is the scripted `ssh` in `tests/fixtures/fakeSsh.mjs`, as in the #429 note (`2026-09-27-host-tailscale-approval.md`): first reporting Node 26.1.0, then running the real launch script against a fake host installation, a real headless host with scripted providers, which this computer pairs with over a real forward. No SSH server, no Tailscale, no provider and no browser were touched.

## What `tests/e2e/host-agent-setup.spec.ts` drove

1. **Choose.** Settings > Hosts > Add host, `forge` typed through **Another SSH host…** in the Device list. Under the SSH host field, **Have my agent set this up** was chosen, with its sentence and a **Model** picker on Claude Test, and **Add it** below it; the main button read **Start setup** (`agent-setup-choose-1280-dark.png`, `agent-setup-choose-820-light.png`).
2. **Working.** Start setup made the thread "Set up forge" and the dialog became "Setting up forge": the line "forge · user and port from your SSH configuration", then "Claude Test is setting up forge in the thread Set up forge. You answer each command it wants to run." with **Open thread**, and every step still to come. The tool's first `host_check` came back `{ ok: false, step: 'install', reason: 'node-too-new' }`; the checklist showed Reached forge and Signed in done, and under Check the host installation, quietly, "The last check stopped here. The SSH host runs Node 26.1.0, …". The scripted thread then asked to run a command, and a card on that step said "The agent wants to run a command on forge. Answer it in the thread to carry on." with Open thread (`agent-setup-working-1280-dark.png`).
3. **Open thread.** It opened the Threads page on "Set up forge", where the command was allowed on its card. Back in Settings > Hosts the page read "Claude Test is setting up forge in the thread Set up forge." with **Show setup**, which brought the dialog back.
4. **Asking.** With the fake now running the real host, the next `host_check` answered `ok: true`; the checklist read "Host installed by the agent" and Host started, and no host was saved. `host_add` then put "Add forge as a host?" in the thread, and the dialog's card on Pair this computer read "Sotto is asking in the thread whether to add forge as a host. Answer it there to carry on." (`agent-setup-asking-820-light.png`). Nothing was added until **Add forge** was pressed on the thread's card; the tool then answered `added: true`.
5. **Connected.** The Hosts page showed the row "SSH forge · Connected", the saved-hosts file held forge, and the page's line read "forge is set up and connected. Claude Test set it up in the thread Set up forge." Show setup opened "forge is connected" with every step done, "Host installed by the agent", and "forge is added and connected. Claude Test set it up in Set up forge; the thread stays in your Threads list until you archive it." **Done** put the setup away (`agent-setup-connected-1280-dark.png`, `agent-setup-connected-1280-light.png`).

A second run started a setup, let the check fail on Node, and pressed **Stop setup**: the dialog read "Setup of forge stopped" with the steps the check had reached and "Setup stopped. Nothing was saved as a host. Anything the agent installed on forge stays there, and the thread Set up forge stays in your Threads list." (`agent-setup-stopped-1280-light.png`). The thread's next `host_add` was refused, Close put the setup away, the page read "No remote hosts yet." and no host was saved.

At each captured moment the spec set 1600x1000, 1280x800 and the 820x560 minimum, dark and light, reduced motion on, checked that the dialog stayed inside the window without scrolling sideways (at the minimum it scrolls in itself), and measured each piece of the new text against its surface, failing below 4.5:1. The lowest ratios (`agent-setup-contrast.json`):

| Text | Dark | Light |
| --- | --- | --- |
| Choice names | 10.43 | 12.38 |
| Choice sentences (muted, 12.5px) | 5.06 | 5.28 |
| Step names, including still to come (muted) | 8.49 | 6.18 |
| "The last check stopped here." (muted) | 8.49 | 6.18 |
| "by the agent" (muted) | 8.49 | 6.18 |
| Card sentences | 17.49 | 14.19 |

`host-setup.spec.ts`, `hosts.spec.ts`, `host-identity.spec.ts` and `host-folder-browser.spec.ts` still pass: with the local host off, the agent's choice is shown turned off with the reason and Add it is chosen, so Add host reads as before.

## What the other suites cover

- `tests/integration/hostSetupTools.test.ts`: Codex, Claude Code and Grok Build fixtures get `sotto_host_setup` for the setup thread and not for another thread (Codex with `default_tools_approval_mode: 'approve'` and a 600-second timeout, Claude with the three tools on `--allowedTools`); the endpoint and token a provider was given reach the tool as the Sotto thread, never the native session, until revoked; Grok's own prompt for the tool is answered without showing and the same name on another server still asks. Over real `DesktopHosts`, a scripted launcher and a real headless host, the tool reports Node missing, then a passing check that keeps no credential, then an add that waits for the answer and pairs; Stop setup during a check leaves no host and no credential.
- `tests/unit/main/hostSetup.test.ts`: the brief's content, and that it names no identity file or secret; one setup at a time, the tool admitted before the brief is sent; refusals before anything starts; Have my agent fix this carrying the failed step's reason; "by the agent"; decline adds nothing; a repeated `host_add` waits on the same answer; Stop setup withdrawing the question and cancelling a running check; an archived thread stopping the setup; the tool server over loopback refusing other threads and arguments.
- `tests/unit/main/sottoRequests.test.ts`: the coordinator merges Sotto's request beside a provider's, keeps it across a refresh, refuses a paired client with no grant, and sends the local window's answer to Sotto and not the provider.
- `tests/unit/renderer/hostAgentSetup.test.tsx`: the choices, the model the picker starts on, the setup view's lines and cards, Close and Show setup, Stop setup, Done, and Have my agent fix this naming the failed attempt.

## Not checked live

The acceptance criteria that need forge itself were not run: a real agent installing the host on a machine without one, fixing a deliberately broken data folder after the user's approval, and a real Tailscale `check` approval during a setup. Each needs the owner's browser and accounts. Nothing here ran a real provider's tool call either: the providers' launch arguments are checked against the fixtures, and a live Claude Code, Codex or Grok Build session calling `host_check` is still to be seen. Those runs are #457, which adds them to this note with their captures. This also lands ahead of #207, the self-contained host archive, so the brief still carries the install steps.

## After review

Unit and integration tests, not captures, cover what the review changed: the setup's check and add no longer share Add host's attempt, so neither cancels the other (`hostSetupTools.test.ts`); a Stop setup that lands as the add saves the host forgets it again (`hostSetup.test.ts`); an SSH question or Tailscale approval during the setup's check is asked over whichever page is open, with Not now, and the Hosts page line says which it waits for (`hostAgentSetup.test.tsx`); and the add card reaches the attention queue of a managed thread (`sottoRequests.test.ts`). The question over the page is the confirmation dialog a saved host's SSH question already uses, with the setup's words and Not now; it has no capture here, and #457 captures it against a real Tailscale approval.
