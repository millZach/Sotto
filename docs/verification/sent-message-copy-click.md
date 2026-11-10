# A click on a sent message's copy control

November 7, 2026. Local verification of `fix/user-message-copy` for [#2322](https://github.com/millZach/Sotto/issues/2322). Zach reported that the copy control on a message he sent did nothing on the Owl built from db71d6022, while a reply's copy control worked.

## Cause

Since 23404c478 (pick B, November 5) a sent message's copy control sits just under the bubble, and the bubble draws an invisible hover reach over the same strip so the pointer can travel down to it. Both are absolutely positioned and the reach comes later, so it was drawn over the control. A click landed on the bubble and nothing was copied. Focus and Enter still copied, and that is all `copy-message.spec.ts` checked. A reply has no reach, so its control was never covered. Clipboard access is not involved: both controls copy through the same main-owned path.

The fix puts the control above the reach (`z-index: 1` on the sent message's control in `threads.css`). Nothing moves and nothing looks different.

## In the running app on forge

The built app (production main and renderer, e2e boundary for the clipboard) at 1280x800 under Xvfb, with a seeded thread of sixteen messages. The probe hovers each message, asks what element sits at its control's centre, presses the real pointer there and reads what main put on the clipboard.

| Build | Sent message: element at the control | Sent message: copied | Reply: copied |
| --- | --- | --- | --- |
| db71d6022 (the Owl Zach runs) | `article.thread-message` | nothing | yes |
| main at 115cf1bbb | `article.thread-message` | nothing | yes |
| this branch | the control | the message's words | yes |

On the Owl's commit the press leaves the control as it was ([after the click](../../artifacts/sent-message-copy-click/owl-db71d6022-after-click.png)). On this branch it says Copied ([after the click](../../artifacts/sent-message-copy-click/fix-after-click.png)).

`copy-message.spec.ts` now has a case that asks what the pointer finds at the control's centre and clicks there with the mouse. It fails on main with `Received: "article.thread-message"` and passes on this branch, with the three cases before it.

The Windows check on Zach's installed Owl is recorded on the pull request.
