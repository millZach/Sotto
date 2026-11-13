# Account copies sent to a paired host

Checked on Windows on November 12, 2026, in the built app, for #2492: the second part of the seventh slice of
`docs/plans/2026-11-11-plugins.md`. The desktop now sends a plugin account to the user's own paired hosts and
Settings › Plugins says where each account's secret is kept. ADR-0205's decision 4 and its notes on account copies
record the decision, and the first part of the slice gave a host the store this part fills.

The host was real and on this computer: Sotto's own headless host, installed and started by the real launch script
over the scripted ssh the other host journeys use, with a made-up key file handed to it as `SOTTO_HOST_KEY_FILE` and
a throwaway home folder, so its data was apart from this account's. It was added as forge from Settings › Hosts &
phones with **Add it**. Vercel was a stand-in: a small server on this computer that knows one made-up token, reached
through `SOTTO_E2E_VERCEL_API_URL`. The run is `tests/e2e/plugins-account-copies.spec.ts`, with the Owl feature
turned on by `SOTTO_OWL_FEATURES=plugins=1` on both the app and the host. Nothing reached Vercel, and no real token
was used.

## What was done

A Vercel account named Work was added before any host was paired. Settings › Plugins said "No other computer is
paired. Pair one in Settings › Hosts & phones, and its threads can use these accounts too.", and the account showed
no place but this computer.

forge was added. Without anything being pressed on Plugins, forge's own record of plugin accounts held Work, with its
name and who it is signed in as, and forge's encrypted credential file held one slot for it. This is a host's first
connection, where the launch script records the desktop a moment after its hello; the copy arrived all the same.
The made-up token was in no file under forge's data folder or this profile in the clear.

On Plugins, **Other computers** listed "forge Connected. Copies kept there: 1 of 1." under **Copy new accounts to
every computer I pair**, switched on. The Vercel row's account showed **Where its secret is kept**: "This computer
Always, in Sotto's encrypted store.", and **Keep a copy of Work on forge** switched on with "A copy is kept on forge."

The page was checked with the copy kept in dark at 1600x1000, 1280x800 and the 820x560 minimum, and in light at
1280x800. Nothing on it was wider than the room it sits in at any of the four.

The switch was turned off from the keyboard, with focus on it and Enter. Once forge had let the copy go it read "No
copy. forge's threads cannot use this account.", forge's record of accounts emptied and its credential slot went, and **Other computers** read
"Copies kept there: 0 of 1." Pressed again, it read "A copy is kept on forge." and forge held the account once more.

The account was then kept to a project, Site, made on this computer for the run. The switch for forge turned off and
could not be pressed, and once forge had let its copy go, account and secret, it read "No copy. Work is kept to
projects on this computer, so its secret stays here. Choose Every project to copy it." **Every project** was pressed: the switch could
be pressed again, read "A copy is kept on forge.", and forge held the account again, as the switch had been left.

**Remove** was pressed and confirmed. forge's record of accounts emptied and its credential slot went. The made-up
token was still in no file in the clear, and the page raised no error.

| Screenshot | What it shows |
| --- | --- |
| `artifacts/plugins-account-copies/copy-kept-dark-1280x800.png` | The account with its copy kept on forge, dark |
| `artifacts/plugins-account-copies/copy-kept-light-1280x800.png` | The same in light |
| `artifacts/plugins-account-copies/copy-kept-dark-820x560.png` | The same at the 820x560 minimum, scrolled to where its secret is kept |
| `artifacts/plugins-account-copies/copy-off-dark-1280x800.png` | The copy switched off, and **Other computers** |
| `artifacts/plugins-account-copies/copy-stays-here-dark-1280x800.png` | The account kept to a project: no copy, and a switch that says why |

## What unit and integration tests cover instead

- `tests/unit/main/plugins/copySync.test.ts`: what is sent when a host connects and what is not sent again, a
  replaced secret and the account's switch reaching the host, a copy switched off, an account removed while the host
  was away, an account kept to chosen projects never sent and taken back, the default for new copies as it stood
  when an account and a computer first met, a host that connected before it was saved, an older host asked nothing
  and sent nothing, each reason a host keeps nothing, a locked credential store, and a failed look tried again. Also
  no secret sent for an account narrowed, or a copy switched off, while the host was still answering; two choices
  made a moment apart both kept; and a host not said to hold no copy until it has said so, away or here.
- `tests/integration/pluginAccountCopies.test.ts`: over a real host's socket, a desktop the launch script recorded
  after its hello is answered and may then send, nothing with a secret leaves a client the host has not answered,
  and the list says what the host holds without a secret.
- `tests/unit/renderer/features/settings/pluginsSettings.test.tsx`: where a secret is kept, each sentence a switch
  can show, a copy that is leaving a host and one that leaves when the host is back, a copy arriving without the page asking, the other computers and the default, and a choice that could
  not be saved.
- `tests/unit/main/plugins/pluginsIpc.test.ts`: only the main window may read the copies or change a choice.

## What is not checked here

- forge itself. Zach's own host keeps a copy only once `SOTTO_HOST_KEY_FILE` is set on it, and that is his to do.
- A host reached over the tailnet with no SSH connection. The run's host was reached over the scripted ssh.
- A host's own threads using a copy. That is the slice's third part; a host only keeps its copies in this one.
- macOS and Linux. The journey runs on Windows, as the other Plugins journeys do.
