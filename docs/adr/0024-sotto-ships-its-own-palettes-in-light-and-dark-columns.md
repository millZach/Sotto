# Sotto ships its own palettes, chosen in Light and Dark columns

Accepted September 22, 2026. Zach asked for the themes to stop being "a straight copy of T3 code". Settings →
Appearance showed T3 Code's card grid, with a sun and moon on every card, and five of the six built-ins were T3's
palettes under Sotto's names (ADR-0011). Three rounds of throwaway prototypes on `prototype/theme-picker` settled
it. The first round offered five pickers on the real Appearance page: today's cards, voice spheres, day-into-night
rooms, Light and Dark columns, and a typeset index that tried each theme on the whole window. Zach chose the
columns. The next two rounds painted the Threads page and Appearance in candidate palettes, light and dark. Zach
chose six. This supersedes the parts of ADR-0011 that name the built-ins and describe the gallery. Its colour
roles, file format, library rules, editor, import and Open VSX client stand.

## Decision

**Six built-ins, all Sotto's own.** In picker order: Sotto, Hush, Linen, Nocturne, Tropic and Citrine. Hush,
Linen and Nocturne are quiet. Citrine is bold. Tropic is the exotic one: its room is coloured, not just its accent.
Each half was grown by the palette engine from a canvas and an accent. The chrome and the surfaces the accent
colours (bubble, selection) were then tuned for how much colour they carry, and every foreground reads at 4.5:1 or
better on its surface. The palettes ship as fixed values in `src/shared/themes/palettes.ts`, and a unit test
checks the contrast of every built-in half.

**Sotto's dark half is Ink.** The thread sits on an almost-black room (OKLCH lightness 0.115). The sidebar is a
lighter graphite (0.235), the reverse of the old look, where the sidebar was darker than the room. The accent is
the app icon's teal: exactly `#47b8a9` in the dark half, and a deeper teal of the same hue in the light half,
because `#47b8a9` on paper is about 2.4:1 and links and focus rings would not read. Sotto keeps the id `t3-code`.

**On the default theme the mark is the app icon.** Every other theme tints the mark with its accent, as ADR-0011
decided. On Sotto the mark wears the icon's own colours in both halves: the teal tile and the black glyph from
`build/icon.svg`. The main window sets `data-brand="app-icon"` on its root when the default theme paints it; an
editor draft never does. The widget's palette now carries one boolean per half, `appIcon`, so the widget sets the
same attribute. It still receives no theme ids.

**T3's five are retired, not migrated.** The ids `t3-chat`, `grove`, `ocean`, `ember` and `iris` no longer
resolve. A half saved on one falls back to Sotto when settings are read, which is the existing rule for a
removed theme, so no migration runs. The ids are no longer reserved, so a T3 file carrying one imports as a
custom theme; T3's legacy aliases (`t3-chat-dark` and the rest) stay reserved. T3 Chat's colours remain in the
code, but not as a built-in. They fill any role a theme file leaves out, as T3 Code does, so T3 files import the
same way as before.

**The picker is two columns.** A color scheme track runs Light, Match Windows (or Match macOS) and Dark. Below it
sit a Light column and a Dark column, each a radio group listing every theme that carries that half. Each theme
shows as a strip of five of its colours (room, sidebar, raised surface, bubble, accent) and its name. The column
for the mode the window is in says so ("Painting the window now.") and stands forward. The other keeps
full-strength text rather than fading, so it still meets contrast. Arrow keys, Home and End move and choose as
native radios do, and each group is one Tab stop. There is no one-press "use for both": each half is chosen in
its own column, which is the point of the layout.

**Duplicating a built-in is Create theme.** Create theme opens the editor on the theme painting the window, which
is what duplicating a built-in did. The user's own themes are managed in a Your themes list below the columns,
with Edit, Duplicate, Export and Remove on each. Removing a collection member opens the multi-select dialog with
that variant already ticked.

## Considered options

- **Voice spheres, day-into-night rooms, the index that tries themes on.** Prototyped and set aside by Zach's pick.
  The index's try-on repainted the whole window on hover; it stays on the prototype branch if the idea returns.
- **Keeping T3's palettes beside the new ones.** That would keep the copy the request was about. Anyone who liked
  one can import T3's theme file.
- **Mapping each retired id to its nearest new palette.** None is close enough for the mapping to feel like the
  same choice. Falling back to the default is the rule users already meet when a theme goes away.
- **Making `#47b8a9` the light accent too.** It fails contrast on paper, so the light half uses the same hue,
  deeper, and only the mark wears the exact icon colour.
- **Keying the icon brand off the accent colour.** The light accent is not the icon colour, so the light-half
  mark would not have been the icon. An explicit flag says what is meant.
- **Fading the column not in use.** Faded text fell below 4.5:1. That column now steps back through its border
  and background instead.

## Consequences

The design gate captures one tuple per built-in in each room, so the five `theme-*` baselines for T3's palettes
are gone and the new ones were captured on purpose. The sun-and-moon cards, the preview circles ported from T3
Code (`ThemePreview.tsx`) and the variant chips are removed; THIRD_PARTY_NOTICES keeps T3 Code's entry for the
role list, file format, editor, inspector, engine and Open VSX client, which still come from it.
`docs/verification/sotto-palettes.md` records the rendered evidence.
