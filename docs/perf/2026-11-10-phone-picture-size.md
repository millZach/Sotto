# A picture at the size a phone shows it (November 10, 2026)

The November 10 audit found the iPhone fetching each picture whole to show it 640 pixels wide (finding 5, #2395). This
note measures the fix: the `thread-media-edge` host feature, which lets a phone's tile ask for a picture at its own edge
and has the desktop answer a copy made with the maker its window's thumbnails use ([ADR-0170](../adr/0170-a-thread-shows-the-pictures-its-agent-made-as-tiles.md),
November 10 amendment), and a headless host answer one made in its picture worker
([ADR-0203](../adr/0203-a-headless-host-makes-a-phones-picture-copies-in-a-worker.md)).

## The short answer

- **A tile's picture from the desktop is about a seventh of what it was.** Run through the desktop's own maker,
  forge's 2,861 kept pictures are sent to a 640-pixel tile at a median of 55.0 KB, against 398.3 KB whole. Together they
  come to 174 MB against 1,431 MB. The issue asked for under 60 KB at the median.
- **Pictures made at forge's median size come at a sixteenth to a twenty-sixth of it,** over the real listener. A
  GIF still comes whole, so it keeps its frames.
- **A phone paired straight to a headless host now gets copies too,** about the size a desktop's are: the same
  screenshot as 17.4 KB where it was 439.7 KB, the photo as 29.3 KB where it was 445.2 KB, over a real headless host's
  listener. forge's own host is one, and its phones are the ones the audit measured. The host makes them in a worker
  process with jpeg-js, pngjs and a JPEG writer of Sotto's own: 50 to 130 ms a picture the first time it is asked for,
  none of it on the host's thread, and its own memory back when the worker ends (below).

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
- `headlessPictureEdge.test.ts`, in the default suite: a real headless host lists the feature with a picture worker and
  not without one; a phone that names 640 is sent at most a tenth of the screenshot and the photo, as JPEGs; the drawing
  stays a PNG; a GIF and a JPEG that will not decode come whole, not refused; the worker's own count of copies answered
  from a process other than the host's is exactly the three it could make, so none was made on the host's thread; and
  two phones asking for one picture together get one copy made once.
- `pictureCopy.test.ts`: the host's fitting and rounding match the desktop's, box averaging and see-through weighting on
  pixels of known values, a PNG only when something shows through, a picture past the limit refused from its header,
  and Sotto's JPEG writer read back by jpeg-js at every size from 1x1 up, with colour sampled two by two.
- `pictureMaker.test.ts`: only PNGs and JPEGs reach the worker, the waiting limit, an idle worker ending, a stuck one
  stopped, and none started after three failures.
- `hostArchive.test.ts`: the host archive compiles in exactly jpeg-js and pngjs, and refuses one more or one fewer.

## Commands

```sh
# The listener's table (Node 24, as CI):
SOTTO_PERF_BENCH=1 npx vitest run tests/integration/socketPictureEdge.test.ts --disable-console-intercept
# A headless host's table, the worker's answers and the phases:
SOTTO_PERF_BENCH=1 npx vitest run tests/integration/headlessPictureEdge.test.ts --disable-console-intercept
# The desktop's maker over a folder of pictures, every one (0), at 640; under xvfb-run on a machine with no screen:
xvfb-run -a npx electron scripts/perf-bench/picture-edge.mjs ~/.sotto/thread-media 0 640
```

## A headless host

### Before: nothing to make a copy with

A headless host runs under plain Node, which reads no picture, and the Electron maker cannot run there, so until
ADR-0203 it listed no `thread-media-edge` and sent every phone every picture whole. As a measure of what a decoder
compiled into the host's bundle would cost, the first part timed `jpeg-js` and `pngjs` on a seeded sample of 60 of
forge's pictures: decoding, scaling to 640 by nearest pixel and writing a JPEG at 85 took a median of 76 ms a picture,
the longest 182 ms, for a median of 57.6 KB.

### After: the picture worker

`tests/integration/headlessPictureEdge.test.ts`, in the default suite. A real headless host (`startHeadlessHost`) over
its real listener, its own thread media store holding the pictures, made in the test the size of forge's as above, and
its picture worker built as `scripts/build-host.mjs` builds it. A phone that accepts the feature asks at 640; one that
does not is sent the whole picture, which is "before".

| Picture | Whole, KB | At 640 from a headless host, KB | Fraction | From the desktop (sharp stand-in), KB |
|---|---:|---:|---:|---:|
| Screenshot, 1600x1000 PNG | 439.7 | 17.4 | 1/25 | 16.6 |
| Photo, 1920x1200 JPEG | 445.2 | 29.3 | 1/15 | 27.2 |
| GIF, two 640x400 frames | 535.5 | 535.5 | whole | 535.5 |
| Drawing that shows through, 1200x800 PNG | 1,109.1 | 286.6 | 1/3.8, a PNG | 298.9 |
| A JPEG cut off a third of the way | 144.9 | 144.9 | whole, not refused | not measured |

The built host itself (`npm run build:host`, then `out/host/index.js` loaded and started with a fixture provider, by
hand, not in the suite) lists the feature on its own, finding `pictureWorker.js` beside it, and sends the screenshot as
17.4 KB and the photo as 29.3 KB, the same bytes.

How long it takes, on forge under Node 24.22.1, with `SOTTO_PERF_BENCH=1` (the worker's answers through `PictureMaker`;
the phases on one thread, the median of six runs after a first that compiles the code):

| Picture | Decode, ms | Scale, ms | Encode, ms | Worker's first answer, ms | Worker again, ms |
|---|---:|---:|---:|---:|---:|
| Screenshot PNG | 19.4 | 18.2 | 12.7 | 93.1 (the worker's start in it) | 49.2 |
| Photo JPEG | 88.2 | 25.3 | 13.3 | 151.2 | 130.0 |
| Drawing PNG | 15.3 | 14.2 | 14.7 | 64.9 | 52.4 |

The photo's grain makes it the slowest thing jpeg-js decodes here; forge's real pictures took a median of 76 ms whole in
the first part's run. A copy is made once a picture and edge: a tile scrolled back into view is sent the kept one.

### The headless host's maker over forge's kept pictures

`scripts/perf-bench/headless-picture-edge.mjs` runs `ReducedPictures` over a `PictureMaker` and the built picture
worker, as a headless host does, on every picture forge's host keeps, after the review's fixes (November 11, 2026). It
reads sizes, counts and times only.

| | Before | After, headless host | Desktop's maker, above |
|---|---:|---:|---:|
| Pictures | 2,982: 2,394 JPEG, 588 PNG | | 2,861 |
| Median sent to a tile | 389.8 KB | 58.3 KB | 55.0 KB |
| All of them | 1,429.0 MB | 225.1 MB | 174.1 MB |
| Sent whole | all | 165: 140 carry a colour profile, 7 already within 640, 18 no smaller or unreadable | 15 |
| Time to make a copy | none | median 80 ms, longest 592 ms, in the worker | median 10.2 ms on main |

The median is under the issue's 60 KB; 1,423 of the 2,982 copies are over it. The total is larger than the desktop's
mostly because the 140 pictures with a colour profile go whole (below) and Sotto's JPEG writer uses the standard's
tables. forge's folder had gained 121 pictures since the desktop's run.

```sh
npm run build:host
node scripts/perf-bench/headless-picture-edge.mjs ~/.sotto/thread-media 0 640
```

### Three choices the numbers made

- **Sotto writes the JPEG itself.** jpeg-js's own encoder writes colour at full resolution: the photo's copy came out
  46.6 KB as sent, a ninth of the picture and over the guard's tenth, where libjpeg at 85 with colour at half
  resolution makes 23.1 KB of the same pixels before base64 (20.9 KB with tables fitted to the picture).
  `src/host/jpegEncoder.ts` writes baseline JPEG from the standard's tables at half-resolution colour, as Electron's
  writer does: 21.9 KB before base64, 29.3 KB as sent, read back at 34.9 dB by libjpeg and 34.8 dB by jpeg-js against
  the pixels it was given. On the unit tests' gradients it keeps what libjpeg's own writer keeps at 85: 29.6 dB against
  29.6 on the steepest, 48.1 against 47.9 at 640x400.
- **The worker is a process, not a thread.** jpeg-js decodes into many small allocations. Six copies, then the worker
  ended, three times over, on a 1920x1200 JPEG and PNG: with a worker thread the host's own process held 154, 180 and 182
  MB more than before it after each; with a worker process, 10, 17 and 17 MB. A process gives its memory back when it
  ends; a thread's goes to the host's allocator, which keeps it. (`MALLOC_ARENA_MAX=1` changed nothing, so it is not
  glibc's per-thread arenas.) Starting a process costs about 40 ms, once after each idle spell.
- **Pictures past 4K are sent whole.** A worker making a copy of a 1920x1200 JPEG peaks about 92 MB above where it
  started, a 3840x2160 JPEG 223 MB, a 4618x3464 one 470 MB. The host decodes up to 3840x2160 and sends anything larger
  whole, as before; the iPhone's own photos are at most 2576 pixels on the long side.

### Where it differs from the desktop's copy

- **Scaling.** Electron resizes with Skia's filter; the host averages each box of pixels that lands on one pixel of the
  copy. Softer on fine lines and small text, and about the same size.
- **Colour profiles.** Neither library reads one, so a PNG or JPEG that carries a profile is sent whole rather than
  shown in other colours: 140 of forge's 2,982 pictures. Electron converts them, so the desktop sends those as copies.
- **A damaged JPEG** is sent whole for the phone to show as it can; Electron might have made a copy of what it could read.
- **JPEG coding.** Sotto's writer uses the standard's Huffman tables, not tables fitted to each picture, so its copies
  are a few per cent larger than libjpeg's at the same quality.

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
- **A headless host on macOS or Windows.** The worker is plain Node and was run on Linux only.
