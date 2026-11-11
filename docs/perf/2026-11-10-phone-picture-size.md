# A picture at the size a phone shows it (November 10, 2026)

The November 10 audit found the iPhone fetching each picture whole to show it 640 pixels wide (finding 5, #2395). This
note measures the fix: the `thread-media-edge` host feature, which lets a phone's tile ask for a picture at its own edge
and has the desktop answer a copy made with the maker its window's thumbnails use ([ADR-0170](../adr/0170-a-thread-shows-the-pictures-its-agent-made-as-tiles.md),
November 10 amendment).

## The short answer

- **A tile's picture from the desktop is about a seventh of what it was.** Run through the desktop's own maker,
  forge's 2,861 kept pictures are sent to a 640-pixel tile at a median of 55.0 KB, against 398.3 KB whole. Together they
  come to 174 MB against 1,431 MB. The issue asked for under 60 KB at the median.
- **Pictures made at forge's median size come at a sixteenth to a twenty-sixth of it,** over the real listener. A
  GIF still comes whole, so it keeps its frames.
- **A phone paired to a headless host gains nothing yet.** A headless host runs under plain Node, which reads no
  picture, so it does not list the feature and its phones fetch whole pictures as before. forge's own host is one, and
  its phones are the ones the audit measured. What it would cost to give one image tools is below.

## Before and after

Sizes are of the data URL the phone is sent, base64 and all, which is what crosses the socket. "Before" is the whole
picture, as every phone was sent it and as a phone that does not accept the feature still is. "After" is what a phone
that accepts it is sent for a tile asking at 640.

### Over the real listener, with pictures made in the test

`tests/integration/socketPictureEdge.test.ts`. The desktop's phone listener over the host service, paired phones speaking
the wire as the iPhone does, the copies kept in a `KeptThumbnails`. The pictures are made in the test with sharp, the
size of forge's (`tests/fixtures/syntheticPictures.ts`), and so are the copies, with a stand-in for Electron's image
tools, which a test under Node cannot load.

| Picture | Whole, KB | At 640, KB | Fraction |
|---|---:|---:|---:|
| Screenshot, 1600x1000 PNG (330 KB file) | 439.7 | 16.6 | 1/26 |
| Photo, 1920x1200 JPEG (334 KB file) | 445.2 | 27.2 | 1/16 |
| The same photo, sent by the user (`preview`) | 445.2 | 27.2 | 1/16 |
| GIF, two 640x400 frames (402 KB file) | 535.5 | 535.5 | whole |
| Drawing that shows through, 1200x800 PNG | 1,109.1 | 298.9 | 1/3.7, a PNG |

The same pictures through the desktop's real maker, under Electron (`scripts/perf-bench/picture-edge.mjs`): screenshot
16.5 KB, photo 26.2 KB, GIF whole, the drawing 306.3 KB: within 1 KB of the stand-in for the screenshot and the photo,
and 7 KB for the drawing.

### The desktop's maker over forge's kept pictures

`scripts/perf-bench/picture-edge.mjs` runs `ReducedPictures` over `mediaEdgeMaker` and Electron's own image tools, as
main does, on every picture forge's host keeps. It reads sizes, counts and times only.

| | Before | After |
|---|---:|---:|
| Pictures | 2,861: 2,317 JPEG, 544 PNG | |
| Median sent to a tile | 398.3 KB | 55.0 KB |
| All of them | 1,431.3 MB | 174.1 MB |
| Sent whole by the new path | all | 15, already within 640 or no smaller as a copy; none carries camera details |
| Main's time to make a copy | none | median 10.2 ms, longest 34.6 ms |

1,222 of the 2,861 copies are over 60 KB; the median is under it. These are forge's pictures through the desktop's
maker, on forge: no desktop holds these pictures, and a phone paired to forge's host is not sent copies (below).

## The guards

- `socketPictureEdge.test.ts`, in the default suite: a phone that accepts `thread-media-edge` and names 640 is sent at
  most a tenth of a large screenshot, photo and sent photo; a phone that does not is sent the whole file, byte for byte;
  a GIF comes whole; a copy is made once; the copies stay inside `MEDIA_TILE_KEEP_BYTES`. It also holds that a host
  without image tools lists nothing and refuses an edge, and that an edge comes only from a phone that accepted the
  feature, and only from the closed few.
- `threadMediaRouting.test.ts`: the maker's own rules on a stand-in for Electron's image, with no codec: fitted to the
  edge, a JPEG at 85, a PNG for one pixel less than opaque, a JPEG with camera details handed back unread, a GIF and a
  WebP not made into copies, and the copies kept to a budget in bytes.
- SottoCore's `PhotoTests`: the tile's request carries `edge: 640`, the viewer's none, an edge the computer does not
  take is never sent, and the hello accepts the feature.

## Commands

```sh
# The listener's table (Node 24, as CI):
SOTTO_PERF_BENCH=1 npx vitest run tests/integration/socketPictureEdge.test.ts --disable-console-intercept
# The desktop's maker over a folder of pictures, every one (0), at 640; under xvfb-run on a machine with no screen:
xvfb-run -a npx electron scripts/perf-bench/picture-edge.mjs ~/.sotto/thread-media 0 640
```

## A headless host, not changed

A headless host would need a picture decoder and a JPEG encoder of its own. Node has neither, and the Electron maker
cannot run there. As a measure of what one compiled into the host's bundle would cost, not a proposal: decoding with
`jpeg-js` and `pngjs`, scaling to 640 by nearest pixel and writing a JPEG at 85 took a median of 76 ms a picture on a
seeded sample of 60 of forge's pictures, the longest 182 ms, all of it on the host's one thread unless moved to a worker,
for a median of 57.6 KB. Electron's maker takes 10 ms for a better scaling. Whether a headless host gets image tools,
which ones and where they run is a decision for its own ADR (ADR-0170, decision 35).

## Not measured

- **The iPhone itself.** The app cannot be built on forge. Its change is the request and the hello; the pull request's
  macOS job is its first compile, and its journeys run there. The iPhone benchmark's picture thread (`--bench-pictures`)
  reads its pictures from a fixture inside the app, not a computer, so it cannot show bytes over a socket; it is not
  changed.
- **A real iPhone paired to a desktop.** The bytes above are what the listener sends; how much sooner a tile fills on a
  phone's link was not timed.
- **The desktop's window.** Its thumbnails are unchanged; they now share their 32 MiB with the copies made for phones.
- **Windows and macOS.** The maker's sizes come from Electron's encoder on Linux; Windows and macOS use the same Skia
  code, and were not run.
