# Effort furnace

Implement the approved B popover from `design/effort-prototype/furnace.html`, revision 6. This is a desktop composer control: selecting the highest effort burns the tokens, then pours their gold into the bar and the word below it.

## Acceptance

- Preserve the existing Figtree composer chips and theme roles. The approved popover is the reference; alternatives were explored in the prototype and B was selected.
- Offer only model-advertised effort values, with smooth dragging and one saved discrete selection on release. Keyboard arrows, Home/End, stop buttons, Escape, Tab and outside dismissal work.
- Animate the words below the bar. Ultra and Claude Max share the forge entrance; neither is gold until tokens finish melting. Lowering effort clears gold. Motion finishes and stops rendering; reduced motion shows the completed still state.
- Keep permission changes independent. Ultrathink inserts a visible instruction into the editable Claude draft. Ultracode is not offered because discovery cannot confirm workflow support; it is not an ordinary effort value.
- The flame, coins and molten bar lead the composition, with effort words and one brief description below. No duplicate selected-effort heading. Use theme colors with readable text; no renderer network or new dependencies.
- Verify dark/light and reduced motion, supported/unknown/single effort catalogs, save failure, disabled controls, and popover bounds at 1600x1000, 1280x800 and 820x560 in the app.

## State

- [x] User approved the prototype, including delayed gold text.
- [x] Inspected native effort discovery: Codex retains generic effort strings; Claude advertises ordinary effort values separately from workflow orchestration.
- [x] Implement composer control and draft integration.
- [x] Check behavior, theme contrast and rendered app.
- [x] Update documentation and record verification.

Verification: `docs/verification/effort-furnace.md`. All feature acceptance checks passed; the full-suite local-data limitations are recorded there.
