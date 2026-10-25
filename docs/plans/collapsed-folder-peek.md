# Peek inside a closed folder

Question: a closed project folder says only its name, its thread count, and a dot when a thread inside is working or waiting on you. Hovering should show the threads inside without opening the folder.

Picked by Zach on October 24, 2026, from `docs/prototypes/collapsed-folder-peek-prototype.html` (three variants on `?variant=`):

1. **B, Ghost opening** — the folder opens in place while you hover or focus it, drawn as a preview with a guide line and a **Preview** foot, and closes again when you leave. Clicking the folder, or **Keep open** in the foot, opens it for real. A (side card) and C (glance summary) were not picked.
2. **Settled gets no peek of its own** — the shelf holds folders, not threads. Open the shelf and the folders inside peek like the ones above it.
3. **Owl feature** — `folder-peek` in `src/shared/owlFeatures.ts`, `sentToStable: false`. Stable shows nothing of it.

## Acceptance

- Resting on a closed project folder (fine pointer) or focusing its toggle shows its threads as a preview after a short intent delay; sweeping across the sidebar shows nothing. Leaving puts the preview away after a short grace; moving into the preview keeps it.
- The preview never changes which folders are open. Opening a thread from the preview leaves its folder closed.
- Preview rows are the folder's rows in the folder's order, with the same states, clocks and actions as an opened folder's rows.
- Keyboard: ArrowDown from a folder toggle steps into the preview; arrows move; Enter opens (Open beside's chord opens beside, as a row does); Escape puts the preview away, returns focus to the toggle, and stays away until focus leaves the folder.
- No preview for an open folder, an empty folder, while searching (search opens folders), or from touch, where a tap toggles the folder as today.
- Light, dark and reduced motion hold; the preview follows the existing theme roles and row type.
- With the Owl feature off, the sidebar behaves exactly as before.

Prototype evidence is in `docs/verification/collapsed-folder-peek.md`. This plan is the Owl entry's owner until the feature earns an ADR.
