# The menu bar owl is alive

Accepted by Drake on October 22, 2026, from the prototype `docs/prototypes/menubar-owl-prototype.html` (variant A, drawn at 1x and shown pixel-doubled). **Number provisional until merge:** 0111 is the newest on `origin/main` at the time of writing; recheck before merging (docs/agents/domain.md). It amends [ADR-0064](0064-sottos-mark-is-the-owl.md) for the macOS menu bar icon only, and is an Owl feature (ADR-0072).

## Context

The macOS menu bar showed the owl's head as one tint, simplified for 16 pixels (ADR-0064 decision 5), and nothing about it ever changed. Drake wanted it alive: a Sotto Owl perched on a wooden branch that flaps its wings every 5 to 10 seconds, glances around, blinks and has glowing eyes, at the quality of the animated mascots in Drake's Agent Status Bar, level with and evenly spaced from the other icons in the bar.

## Decision

**The menu bar owl.** On a Mac running a Sotto Owl build, the menu bar item is the Sotto mark's own owl outline, in colour, perched on a wooden branch with a twig. It flaps its wings every 5 to 10 seconds (start to start, drawn at random; a flap picks one of three: two full wingbeats, two quick shallow ones, or one slow stretch), glances around every few seconds with a lean of its head and a flare in its eyes, blinks, and keeps its eyes lit. Between those changes nothing happens: the icon changes only when the picture does.

**The look is the 1x one, pixel-doubled.** Drake picked the smooth owl's artwork drawn at its own 1x size, 27 by 22 points, and shown with each pixel a crisp 2 by 2 block on a Retina bar, over both the same art drawn finely at 2x ("too realistic") and a hand-made pixel owl. The blocky look is the point, so the frames are drawn once at 1x and main doubles them; a plain display shows them as drawn.

**Frames are drawn ahead of time.** `src/main/tray/owl/poses.mjs` lists every pose the schedule can show (73), `scripts/generate-tray-owl.mjs` (`npm run tray:owl`) draws each at 1x for each of the nine body and eye colours into `resources/tray/owl/`, where they are committed, and the app only swaps pre-built images with `tray.setImage`. There is no drawing library at run time; main inflates a palette's file, doubles the pixels, encodes PNGs with `node:zlib` (as the Dock icon does, ADR-0064) and builds one image per frame.

**One timer, no ticking.** The schedule asks for the next change and the app sets one timer for it. On average it swaps the image about 160 times a minute. Running the app's own animator for two 3-minute stretches on a bare Electron 43 tray cost its main process 0.84% and 0.78% of one core (about 2.9 ms a swap, 175 and 159 swaps a minute), and 0.03% with reduced motion on, when it swaps nothing. With reduced motion, from the system or from Sotto's own setting, the owl sits still on its rest frame and no timer is set; it also stops while the screen is locked or the Mac sleeps, or if anything in the owl fails: a failure stops it where it is, and starting Sotto and saving settings carry on.

**Level and spaced like the others.** Measured in a real status item on macOS 27 with the app's frames: the image is drawn at its own size, centred, with 1 point of padding each side; the art sits 3.0 points from both edges of its item, where Apple's own symbols sit 2.5 to 3.0, and its centre falls on the same line as theirs (22.0 points below the top of the bar's window; theirs 21.75 to 22.0). The image is 22 points tall at most, because a taller one makes the item grow and drift up. The item grows from 18 points wide to 29.

**Two settings, under Settings → Appearance:** **Owl body** (Slate, Ink, Light) and **Owl eyes** (Sotto teal, Ice blue, Amber), shown on a Mac in an Owl build and changing the icon at once. The shipped default is slate with teal eyes; Drake's own choice, ink with amber eyes, is Drake's setting, not the default.

**An Owl feature (`menu-bar-owl`).** Stable shows and starts none of it, keeps today's one-tint template icon, and keeps the two saved settings whole. It goes to stable when Zach sets its `sentToStable`.

**What stays as it was.** The app icon, the Dock icon and the mark inside the app keep decisions 1 to 5 of ADR-0064. For the menu bar icon alone this amends decision 1 (the macOS menu bar template is replaced on Owl builds by the colour frames), decision 3 (the owl is black: its body is slate, ink or light) and decision 5 (the menu bar owl is simplified for 16 pixels, with no beak: it has a beak and a branch). `build/tray-template.svg` stays, for stable, for a Mac whose frames cannot be loaded, and for the Omarchy bar. Windows and Linux keep their own tray icons.

## Alternatives the prototype showed

- **B, a pixel owl on a 1 point grid,** like the Agent Status Bar's mascots: the crispest at this size, and Drake preferred A at 1x.
- **C, one tint** that macOS recolours: the most native, but its eyes can only be solid or cut out, never lit.

## Consequences

- The menu bar item is 11 points wider than before. On a crowded notched bar that is room the notch does not leave.
- A coloured icon cannot recolour itself for a dark or light bar, so the frames use colours that read on both and over the three wallpapers tried. How macOS draws the owl while its menu is open was not checked.
- `scripts/generate-tray-owl.mjs` is run by hand, and the generated files are committed. A new pose is a change to `poses.mjs`; a new drawing is a change to `scripts/lib/trayOwlDraw.mjs` and to variant A of the prototype, because each run refuses to write frames that differ from the prototype's own, for all nine colours.
- The schedule runs only on a Mac in an Owl build, so Windows and the stable track pay nothing.
- Not decided here: the owl reacting to dictation or to a thread working or waiting. It is a later question.
