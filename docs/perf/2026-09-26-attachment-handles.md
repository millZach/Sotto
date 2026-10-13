# Staged images carry a handle - September 26, 2026

Issue #320, [ADR-0031](../adr/0031-images-are-staged-once-and-carried-by-handle.md). An image attached to a draft used to travel as a base64 data URL inside everything that mentioned the draft: the window's debounced save and main's answer to it, the shell main pushes to the main window and the widget, every write of `agents.json`, and the preview file a send rewrote. Now the window hands the bytes to main once, main keeps them as one file in the host's attachment store, and everything else carries a handle of about 150 bytes.

## Numbers

One 8 MiB screenshot in the Workshop thread's draft, nine text-only saves of that draft, then one send of an 8 MiB image. Bytes are the size of what crosses: `node:v8`'s `serialize` for IPC payloads (what Electron's structured clone puts on the wire, approximately) and the file size for what is written. Two runs each (three for the after figures) on the development machine (Windows 11, 24 cores, Node v24.14.1) while other agents' test suites were running on it; the byte counts were the same in every run, and the times are ranges.

| For each | Before | After |
| --- | ---: | ---: |
| Draft save the window sends | 11,185,057 B | 337 B |
| Main's answer to it | 11,186,903 B | 2,183 B |
| Shell, per push, per window | 11,186,990 B | 2,270 B |
| Largest push while the draft held the image | 22,372,238 B | 2,270 B |
| `agents.json`, per write | 11,186,173 B | 1,472 B |
| `attachment-previews.json` after the send | 11,185,230 B | 529 B |
| A draft save, admission to answer | 230-334 ms | 2.0-4.4 ms |
| Building the shell | 24-26 ms | 0.02-0.06 ms |
| One write of `agents.json` | 108-123 ms | 1.6-3.0 ms |

The largest push before was two copies of the image, the thread's draft and the coordinator's own draft, which a manual send filled with the same image. The shell cost what it did because it hashed every draft, bytes and all, to report whether each was saved.

What moved is paid once, when the image is attached: hashing 8 MiB, writing it to its own file, syncing it and naming it in the index took 20-27 ms (median of nine distinct images). A second draft or a send of the same image stages nothing more. The window now reads the file as bytes rather than as a data URL, and its chip shows a thumbnail it drew at most 256 pixels on the long side.

## What these numbers are and are not

- They are Sotto's own work and the disk. The provider is the in-process E2E host. A send still reads the image once, at the adapter, and hands the provider the same base64 it did before. Since the review, the store also hashes what it reads from disk to check it is still the image the user attached, which for 8 MiB is the same 20 ms or so as hashing it at staging, small beside the send.
- "Before" is `origin/main` at `e093bd6c`, measured in place before any change with a benchmark that did the same things with a data URL (it is not committed, since the API it drove is gone). "After" is `tests/perf/attachmentHandles.perf.test.ts`.
- The widget receives the same shell as the main window, so the per-window figure applies to each of them.
- A remote host's shell crosses the socket as JSON rather than structured clone; the draft's share of it falls the same way, from the base64 to the handle.

## Re-run

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/attachmentHandles.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

Without `SOTTO_PERF_BENCH=1` only the byte half runs, and it asserts that each byte count above stays under 64 KB with the image in the draft; it runs in the default suite. Each line it prints is counters or timers only: nothing about the prompt or the image is recorded.
