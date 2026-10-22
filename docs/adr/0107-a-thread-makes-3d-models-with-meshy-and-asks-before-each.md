# A thread makes 3D models with Meshy and asks before each

## Status

Proposed October 22, 2026. Zach asked on October 22 for something like the Meshy plugin Nous Research shows for Hermes Agent, and chose its shape the same day. It adds two hosts and a second paid key, so it is an ADR and a README change before it is a patch (AGENTS.md). It is an Owl feature ([ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). It adds a standing exception to "the user answers every permission", which the user turns on in Settings and which is off by default; see the last decision below.

## Context

Meshy makes a textured 3D model from words or from one to four photos, in a few minutes, through a documented REST API at `api.meshy.ai` with one bearer key. Finished files are served from `assets.meshy.ai` under signed links. The facts below were read from Meshy's own docs and terms on October 22, 2026 and are what this record rests on:

- **Price.** Credits, on a paid plan only: the free plan has no API access. Pro is $20 a month for 1,000 credits, about two cents a credit. A model made from words is a 20-credit shape and a 10-credit texture; a textured model from a photo is 30. A task that fails is refunded; deleting one that has not started is refunded, and one already running is charged. There is no test key since September 16, 2026.
- **Retention.** Meshy deletes what the API made after three days, so a link it returns stops working.
- **Training.** Meshy's terms (§2.9) let it use the words, photos and models of every customer below Enterprise to train and improve its services, and none of its documents offers a way to turn that off. Its help centre says the data is stored with AWS in the United States.
- **Formats.** GLB, FBX, OBJ with MTL, USDZ, STL and 3MF, texture maps, and still thumbnails. Turntable videos are deprecated.
- **Existing integrations.** Meshy publishes an MCP server and a Claude Code plugin. Both keep the key outside the operating system's credential store (an environment variable, or a plain file at `~/.config/meshy/credentials.json`), and only a Claude Code thread could use the plugin.

Zach decided, against the mock-up `docs/prototypes/meshy-models-prototype.html`:

- An Owl feature.
- A tool for every thread, a key in Settings, and the model shown in four places: inline in the thread, a gallery page, a surface in Tools, and the iPhone app.
- Inline, variant A: a quiet line with a still picture, the name, the cost and the file count, which opens a turnable viewer in place.
- Gallery, variant C: one large turnable viewer with the details beside it and a filmstrip of every 3D model below.
- Tools gets its own surface for the thread's 3D models, rather than showing them inside Files.
- Each 3D model asks first, with what it costs, and a Settings switch turns asking off; asking is on by default.
- Meshy's training terms are acceptable if Sotto says so plainly wherever the key is added and wherever a 3D model is asked for.
- No stop button while a 3D model is made, and no "See it in your room" on the iPhone, in the first version.

## Decision

**A 3D model is a file Meshy made for one thread, saved in that thread's folder.** The thread's agent calls one Sotto tool, `make_3d_model`, with either the words to send or the path of a photo, a name, an optional triangle target, and the formats it wants (GLB always, plus any of FBX, OBJ, USDZ and STL). Sotto runs the Meshy tasks, downloads every file and the still pictures into `models/` in the thread's working folder (or a folder inside it that the agent names), and answers the tool with the paths. The files are the user's: Sotto never deletes them, and a thread's agent edits, commits or moves them like any other file. The tool is offered to every provider that takes Sotto's tools, on threads that run on this computer.

**Each 3D model asks first, with what it costs.** The request names the thread, shows the words or the photo that would go to Meshy, says that Meshy may use them to train its own models, gives the credits it will cost and this month's credits so far, and waits for **Make the model** or **Deny**. Nothing reaches Meshy before the user answers. The answer covers that one 3D model, its shape and its texture, and nothing after it.

**Sotto keeps the bill inside a limit.** Settings holds a monthly credit limit, 1,000 by default, which is Meshy's Pro plan. Sotto counts the credits each task cost, from Meshy's price table at the time it asks, and refunds the count when Meshy reports a failure. It refuses a 3D model that would pass the limit before anything is sent, and says so to the agent and in the thread.

**One key, in the credential store.** The Meshy key lives in the operating system's credential store in its own slot, beside the OpenRouter and run.cloud keys, and main alone reads it. It never reaches the renderer, a log, an agent or a file. With no key saved, the tool tells the agent to ask the user to add one in Settings, and nothing else changes.

**Only what the user approved leaves the computer.** Words go as the agent wrote them, up to Meshy's 800 characters. A photo must be a file inside the thread's working folder or an image attached to the thread; Sotto redraws it without its location and camera details, as the iPhone app does, at no more than Meshy's 20 MB, and sends it as a data address, never as a link to somewhere else. Sotto re-checks the path, its real location and its size right before sending and refuses a photo that changed since the agent asked. Downloads come only from `assets.meshy.ai` over HTTPS, are capped in size, and are written only inside the target folder.

**Meshy sits behind one adapter.** `src/main/tools/meshy/` speaks Meshy's API with Node's `fetch`: no SDK, no MCP server, no new runtime dependency. It polls each task at the pace Meshy's `Retry-After` asks, five seconds when it does not say. Everything else addresses a 3D model by its Sotto thread and its own ID, never by Meshy's task ID, so another service can replace Meshy without touching the tool or the views. Meshy's task IDs are kept with the record so that a 3D model still being made when Sotto quits is picked up again when Sotto starts, while Meshy still has it; after three days the record says it was lost and that nothing more will be charged.

**Sotto keeps a record of each 3D model.** In its own table, like a visual: the thread, the name, the words or the photo's file name, the files, the credits, when it was asked for, made or failed. The record follows Keep local history and forgetting a thread, as a visual does; removing the record never touches the files. The gallery and the Tools surface read these records and the files they name; a record whose files are gone says so and offers to remove itself.

**The viewer draws the file on this computer and contacts no one.** The renderer draws a GLB with WebGL from bytes main reads out of the thread's folder through a preload bridge. A GLB that points at anything outside itself is refused rather than followed. The drawing code is bundled into the renderer as a devDependency, not a runtime dependency. The thread shows the inline line of variant A, which opens the turnable viewer in place; the gallery page shows variant C; Tools has a surface for the open thread's 3D models, between iPhone and Terminal. A reader that cannot draw one gets its still picture, its name and its files.

**The iPhone shows the still picture and turns the USDZ.** A paired phone gets the record and the still picture with the thread, and opens the USDZ in the app's own 3D view when the user presses it. The file travels from the computer that runs the thread over the existing phone connection, only when pressed, and stays in the app's cache. Nothing is sent from the phone to Meshy, and the phone cannot ask for a 3D model to be made except by writing to the thread.

**Turning asking off is a standing grant the user makes, bounded by the limit.** **Ask before each 3D model** in Settings is on by default. Off, a thread makes 3D models without asking until the month's limit is reached, and every one still shows in the thread with what it cost. This is the second standing exception to "the user answers every permission" after [ADR-0029](0029-a-thread-uses-the-browser-without-asking-by-default.md): it is made only by the user's own switch, reaches only Meshy and only up to the limit, and turning the switch back on ends it at once. A memory, a repetition or a provider's confirmation never turns it off.

**Owl only.** The feature is `meshy-3d-models` in `src/shared/owlFeatures.ts`. Stable shows no tool, no Settings section, no gallery and no Tools surface, starts no task, and keeps the key and the records whole, so a return to Owl finds them.

## Consequences

- `README.md` names `api.meshy.ai` and `assets.meshy.ai` under "Privacy and cost", as hosts used only once you add a Meshy key, and says that Meshy may train on what is sent. `AGENTS.md` names this record beside ADR-0029 as a standing exception.
- Sotto has a third paid key, after OpenRouter and run.cloud. The user pays Meshy directly and needs a paid Meshy plan.
- Threads on a paired host get no `make_3d_model` tool in this version: the key stays on the desktop, and sending it to a host, or running the tasks on the desktop for a host's thread, is a later decision.
- A 3D model cannot be stopped once it is asked for. Meshy would charge for a running task anyway.
- The Tools rail grows to eight surfaces, which fits the 820x560 minimum only just; `CONTEXT.md`'s Tools panel entry changes with it.
- "Model" already means the AI model a thread runs on, so the glossary names this a **3D model**, and the gallery page and the Tools surface are named **3D models**, not "Models" as the mock-up had it.
- Live checks need a Meshy key on a paid plan and spend credits. The adapter's tests run against a local fake of Meshy's API.
