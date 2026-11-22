# iPhone attachment menu

Checked on a folded iPhone Duo simulator running iOS 27.2 with Xcode 27.2. Both journeys used Sotto’s in-memory host fixture.

- **Thread, dark appearance.** Typed a draft, opened the attachment list and checked that its last row ended above the text field. The keyboard stayed visible. Files opened the system picker, and Cancel returned to the same draft. The focused journey is `testAttachmentListAboveTheDraftOpensFiles`. [Thread with the keyboard open](../../artifacts/iphone-small-reply-box/attachment-menu-folded.jpg)
- **Watcher, light appearance, XXXL text.** Opened the list from the small reply box, chose Photos and videos, and canceled the system library picker. The + button was available again. [Watcher at larger text](../../artifacts/iphone-small-reply-box/attachment-menu-watcher-light.jpg)

The fixture accepts files and videos. Its host lacks photo staging, so the captures show the existing update message. Camera capture needs a physical device.
