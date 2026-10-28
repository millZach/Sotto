# Share to Sotto puts what you share in Watcher's box

## Status

Accepted October 28, 2026, at Drake's request: "if I hit the share button I can just hit 'share to Sotto' and it will bring it to the Watcher thread and then I can also type text." It adds a second way into the iPhone app beside opening it, and the app's first App Group. It leans on [ADR-0131](0131-any-file-can-be-attached.md) (files in a reply box, amended the same day for Watcher's box) and on the phone's Watcher ([ADR-0073](0073-watcher-coordinates-threads-with-its-providers-own-tools.md)).

## Context

The iPhone app took photos from the + menu and, in a thread's box, files from the Files app. Anything seen elsewhere on the phone (a screenshot, a PDF in Mail, a page in Safari) had to be saved first and then found again from inside Sotto. iOS offers apps a share extension: a small separate program the share sheet runs, which cannot reach the app's memory or its connections, only a folder the two share.

## Decision

1. **A share extension named Sotto.** The iPhone app carries a share extension (`apps/ios/SottoShare`, bundle `com.millzach.sotto.ios.share`) that the share sheet offers for up to 8 images or files, one web link, or text. It sends nothing anywhere. It copies the files as they came and writes the words (shared text and links, one to a line) into its own folder in the App Group `group.com.millzach.sotto.ios`, writes `share.json` last, and opens Sotto with `sotto-share://inbox`.
2. **The app takes the share when it comes forward.** On opening, on coming forward and on that link, the app moves every complete share out of the group's folder into its own temporary folder. A share iOS would not open Sotto for waits there until the user opens Sotto, and one left a day is removed. The group's folder is kept out of backups, and a file larger than a reply can carry is not copied.
3. **Into Watcher's box, never sent.** The words go into Watcher's text field, after anything already typed; images go in as photos, made ready as a library photo is, HEIC included; everything else goes in as files. The Watcher tab opens with the caret in the field. Nothing is sent until the user presses Send, so sharing approves nothing and asks nothing of a computer. The temporary copies go once the box has read them.
4. **Where Watcher isn't, a new thread.** When no paired computer shows this iPhone a Watcher that can take a message, after waiting a few seconds for computers still being reached, Threads opens New thread with one line saying the share goes in a new thread, and the thread it opens takes it in its reply box. Closing the sheet without a thread lets the share go.
5. **Signed like the app.** The TestFlight job archives both and its export signs both with automatic signing; each target has the App Group entitlement. The simulator-only pull request job builds the extension unsigned, as it builds the app.

## Consequences

- **No new host and no new key.** A share reaches a computer only as the box's photos and files do, when Send is pressed. The README's "Privacy and cost" says shared items wait on the iPhone, in Sotto's own folders, until they are in the box.
- The extension opens Sotto through the responder chain, which iOS does not promise to keep. If it stops, the extension says so and the share waits for the next time Sotto is opened (decision 2).
- A computer whose Sotto keeps no files for Watcher takes the shared photos and words, and says to update it for the files, in the box's own words.
- An item that comes without a name is named in English ("Shared photo", "Pasted file"), as the + menu's "Photo 1" and "Camera photo" are: the name goes to the computer as a file name.
