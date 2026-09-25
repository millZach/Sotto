# The branch toolbar as its own row of buttons (#325)

The question: the branch toolbar (Run on, Workspace, the pull request badge and the branch picker) sat inside the composer card under a hairline and read as a divider stuck to the message box. Where should it sit, and what should its controls look like?

## The pick

`docs/prototypes/branch-toolbar-prototype.html` showed four states of the real composer on `?variant=now|a|b|c`, in the Sotto dark palette and in light, at the working width and the 820px minimum, with the picker open and with a long ref name in its list:

- **NOW.** Today's row inside the card, for comparison.
- **A, Buttons.** The card ends at the send disc. Below it each control is its own bordered pill, the option chips' pill a size smaller. Run on is a quiet label pill with a laptop or server glyph and no chevron.
- **B, Tray.** One low tray under the card, on the follow-up ledger's surface, holding the same controls as ghost chips.
- **C, Segments.** One segmented control at the left (This computer, Current checkout, branch), the Git action's grammar, with the badge at the right.

Zach chose **A** on September 24, 2026 ("A looks great lets go with that"). It is the closest reading of the ask, and A and B wrap cleanly at the minimum width where C's segmented group cannot.

## What shipped beyond the drawing

- The badge and the picker are grouped so they wrap together onto the second line at 820px, still at the right. In the prototype the picker alone dropped to the left of the second line, which the first app capture showed and which read as a stray.
- Run on and a locked Workspace keep their key words as visually hidden text, so the screen reader and the existing tests still read "Run on This computer" and "Workspace Current checkout".

## The picker's list

The same change fixes the list clipping in the picker: its grid column was `auto`, so it sized itself to the widest no-wrap row and scrolled sideways. `minmax(0, 1fr)` with no sideways scroll lets a long name ellipsize with its badges in place. The prototype's "Show today's clipping" toggle shows the before and after.

Evidence: `docs/verification/2026-09-24-branch-toolbar-buttons.md`.
