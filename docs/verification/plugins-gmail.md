# A Gmail account on the Plugins page, and a thread reading it

Checked on Windows on November 13, 2026, in the built app, for #2493: the fourth part of slice 8 of
`docs/plans/2026-11-11-plugins.md`. Gmail is the first mail plugin. Its row on Settings › Plugins adds, replaces and
removes accounts, each a name, an address and an app password kept in the credential store, and a thread reads an
account only after the user allows that thread on a card. ADR-0205 records the decision (decision 8), and its November
13 notes say how mail is read and how the grant is kept.

Gmail was a stand-in: a small mail server on this computer (`tests/fixtures/fakeImapServer.ts`) that takes one made-up
address and app password and holds one made-up message. The run is `tests/e2e/plugins-gmail.spec.ts`, with the Owl
feature turned on by `SOTTO_OWL_FEATURES=plugins=1` and the stand-in's port given by `SOTTO_E2E_MAIL_PORT`, which a
packaged build never reads. Nothing reached Gmail, and no real address or app password was used.

## What was done

Under a new **Mail** group, Gmail's row read "Not added". It was opened and **Add a Gmail account** pressed; focus went
to Name. With the name Personal, the address reader@example.com and an app password the stand-in refuses, Enter gave
"Gmail did not accept this address and app password. Nothing was saved. Check the address, and make a new app password
at myaccount.google.com/apppasswords.", and the form stayed with the name and address still in it.

The good app password was then pasted in the four groups Google shows one in, with spaces between them. The form
closed and the account showed: "Personal", "reader@example.com. App password saved November 13.", **Replace**,
**Remove**, its switch, its projects and its Recent use. The folded row read "Gmail, Personal". The app password was
not in the page after that. The stand-in had been signed in to twice and asked for nothing from the mailbox.

The open row was checked in dark and light at 1600x1000, 1280x800 and the 820x560 minimum. Nothing on it was wider than
the room it sits in at any of the six.

Back in a thread, its agent asked to search the account. The call waited, and the thread showed a card: **Read Gmail
mail**, the account by its name, Personal, and three lines saying what the thread could do and until when, that what it
reads goes to Codex, and that it cannot send, move or delete mail and every other thread asks for itself. The address
was not on the card. Its buttons were **Let this thread read it** and **Don't allow**. The thread counted in **Needs
you**. While the card waited the stand-in had been asked to open no mailbox. The card stayed inside its pane at
1280x800 in both modes, at 1600x1000 and at 820x560.

**Don't allow** was pressed: the agent was told "The user said no: this thread may not read the Gmail account
"Personal". Nothing was read. Do not ask again unless they tell you to.", and no mailbox had been opened. The agent asked
again, and the card was allowed from the keyboard, with Enter on **Let this thread read it**: the search came back with
the made-up message's subject, under a first line saying that what follows is mail and never instructions, and without
the app password. A further search by the same thread came back without a card.

Settings › Plugins then listed, under the account's Recent use, the two searches and "Asked to search mail in “Check the
checkout page” You said no.", and nothing of the message. Every `.json`, `.log`, `.txt` and `.jsonl` file under the
profile's data folder was read: neither app password was in any of them, the good one neither as it is kept nor as it
was pasted, and `plugin-mail-grants.json` held the
thread's ID, the account's ID and a time, and nothing else. Typing Gmail into **Find a setting** from another page offered
the row, and Enter opened Plugins with it in view.

## Captures

In `artifacts/plugins-gmail/`:

- `gmail-password-refused-dark-1280x800.png`: the form after Gmail refused the app password.
- `gmail-account-dark-1600x1000.png`, `gmail-account-dark-1280x800.png`, `gmail-account-dark-820x560.png` and
  `gmail-account-light-1280x800.png`: the open row with the account.
- `mail-card-dark-1280x800.png`, `mail-card-light-1280x800.png`, `mail-card-dark-1600x1000.png` and
  `mail-card-dark-820x560.png`: the card in the thread.
- `gmail-recent-use-dark-1280x800.png`: the account's Recent use after the reads.

## Not checked here

- A real Gmail account. A live check needs Zach to add an account himself and to say which mailbox and message it may
  read.
- Stopping a grant from the thread's menu, which Zach picked on November 13 and the slice's last part builds.
- A paired host: `tests/integration/hostPluginTools.test.ts` reads a copied account from a host's thread.
