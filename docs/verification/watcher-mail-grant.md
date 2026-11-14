# Ask before Watcher reads, in Watcher's strip

Checked on Windows on November 13, 2026, in the built app, for #2563: a follow-up to slice 8 of
`docs/plans/2026-11-11-plugins.md`. A thread ends its mail grant from its ··· menu, and Watcher's room had no such
menu, while Watcher is never settled. Zach picked a ··· menu at the end of Watcher's strip from the mock-up kept as the
tag `prototype/watcher-mail-grant` (answer A). ADR-0205 records it under decision 8's notes on stopping a mail grant.

The run is `tests/e2e/watcher-mail-grant.spec.ts`, on the Sotto Owl track against main's own Watcher over the fake Codex
app server, with nothing seeded. Gmail was a stand-in: the small mail server on this computer
(`tests/fixtures/fakeImapServer.ts`), with one made-up address, app password and message. Nothing reached Gmail.

## What was done

Watcher was started from its room's first entry, and a Gmail account named Personal was added. Watcher's strip then
held what it holds today: the tile, the Watcher and Teams tabs, All threads, and Stop all at its end. It had no ···
menu at 1600x1000, 1280x800 or the 820x560 minimum.

Watcher's agent asked to search the account. The call waited on a card in Watcher's room, **Read Gmail mail**, naming
Personal and not its address. The stand-in had been asked for nothing from the mailbox, and the strip still had no
menu. **Let this thread read it** was pressed, and the read came back with the made-up message.

The strip now ended in a ··· button named More actions, after Stop all. In dark and light at each of the three sizes:

- The tile, the tabs and All threads were exactly where they were before, to the pixel.
- Stop all was the size it was and had stepped left by the button's width and the six pixels between them, so the
  button ends where Stop all used to end.
- The button was inside the strip, and nothing on the page ran outside the window.
- Opened, the menu held one row, **Ask before Watcher reads Personal**, whole inside the window and not cut short.

From the keyboard, Tab went from All threads to Stop all to the menu's button. Enter opened the menu with focus on its
row, and Escape closed it and gave focus back to the button. The button does not drag the window.

A second read did not ask. The row was then pressed from the keyboard. The menu went, no error showed, focus was on
All threads, the grants file held no grant, and at all three sizes Stop all was back where it began. Watcher's agent asked to search again: the call
waited on a card again, **Don't allow** was pressed, the agent was told no, and the stand-in was asked for nothing more.

## Not checked here

- A Stop that could not be written. `tests/unit/renderer/watcherMailGrant.test.tsx` checks that the room then says
  "Sotto could not stop Watcher reading Personal, so it can still read it. Try again." once, and keeps the row.
- A grant that ends some other way while the menu is open. The same file checks that the menu is closed, that focus
  goes to All threads only if the menu held it, and that the menu is closed when Watcher is next let read.
- macOS and Linux. The strip's menu is the thread pane's own menu, and the journey runs on Windows only.
- A real Gmail account.

## Captures

In `artifacts/watcher-mail-grant/`:

- `strip-no-grant-dark-820x560.png`: the strip before Watcher can read a mail account, at the minimum size.
- `card-first-read-dark-1280x800.png`: the card Watcher's first read waits on.
- `strip-menu-dark-1600x1000.png`, `strip-menu-dark-1280x800.png`, `strip-menu-dark-820x560.png`,
  `strip-menu-light-1600x1000.png`, `strip-menu-light-1280x800.png`, `strip-menu-light-820x560.png`: the strip with
  the menu's button at rest.
- `strip-menu-open-dark-1600x1000.png`, `strip-menu-open-dark-1280x800.png`, `strip-menu-open-dark-820x560.png`,
  `strip-menu-open-light-1280x800.png`: the menu open on its row.
