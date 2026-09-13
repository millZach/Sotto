# Redesign round 3: ground-up shells

Three complete shells for the two main pages, Dictate and Agents. Nothing from the
current app's chrome is reused: no rail, no titlebar, no Manrope/slate tokens. The
only survivors are the floating widget (untouched, not shown here) and its
seven-bar wave, which every direction uses as the Dictate glyph and hero.

All three share `orb.js`, a canvas wireframe orb (deforming sphere, halo, dust)
modelled on the reference images. It has five colour presets (violet, ice, teal,
amber, mono) and five states (idle, wake, listening, speaking, working). The
Agents page in each direction is pure black with the orb as the only bold element.

## Open a mockup

Open any HTML file in a browser. URL parameters set the state:

| param       | values                                         |
|-------------|------------------------------------------------|
| `view`      | `dictate`, `agents`                            |
| `state`     | `ready`, `listening` (dictate)                 |
| `sec`       | Crossing settings: `dictation`, `transcription`, `account`, `cleanup`, `output`, `application`, `agents`; `guide=1` opens the server walkthrough |
| `view=dictionary` | Crossing dictionary page (words and snippets) |
| `view=threads` | Crossing threads page. `open=N` expands row N and scrolls to it; `thr=none` shows the empty state; `tq` prefills the search |
| `hist`      | `none`, `off` (Crossing history empty states); `q` prefills the search |
| `theme`     | `light`, `dark` (Harbor and Spine dictate; `t` key toggles). Crossing is black only |
| `orb`       | `wake`, `listening`, `speaking`, `working`     |
| `color`     | `violet`, `ice`, `teal`, `amber`, `mono`       |
| `attention` | `1` shows a permission request (`a` toggles)   |
| `drawer`    | `1` opens the session transcript (01 and 03)   |
| `still`     | `1` freezes the orb for deterministic capture  |

Clicking the orb cycles its states. Swatches change its colour live.

## Render PNGs

From the repo root:

```
node design/redesign-3/capture.mjs        # all three
node design/redesign-3/capture.mjs 02     # one direction by prefix
```

Seven shots per direction at 2x (Crossing has no light theme but adds three history, four settings and one dictionary shot): dictate ready light/dark, dictate listening,
agents wake, agents listening (ice), agents attention, agents session (teal).

## The directions

### 01 Crossing, `01-crossing.html`

One switch decides everything. A centred two-state control in a thin top strip
(wave glyph for Dictate, orb glyph for Agents) flips the content of one black
room. Dictate is a single centred column: huge teal wave, one sentence, one
button, then the last transcript at reading size. Agents is the
orb at full height with a caption, session pills below, a permission card that
floats over the orb, and a right sheet for a session transcript. History,
Settings and Help live as plain text links in a footer with the colour swatches
and voice chip. The orb defaults to the same teal as the dictation wave so the
two screens read as one app. History is the dictate room's last-transcript row
continued: one 720px reading column, day labels, every transcript a row that
opens in place with its facts and Copy/Delete, search in the head, and the
keep-it-local sentence and Clear history in the footer. Settings is the same
column with a sticky six-line index beside it. Each section opens with one
sentence that reads the current state back in plain words, then rows with the
control on the right: switches, segmented choices for up to four options,
round selects, and fields that save on blur. No Save buttons. Transcription
is Parakeet v2 (Standard) and v3 (Multilingual); the network transcription
server gets a three-step walkthrough in a right-hand sheet. AI account detects
Claude, ChatGPT and Grok sign-ins and offers account, model and reasoning
dropdowns, or an OpenRouter key. Cleanup has three tiers. Agents is only a
pointer to its own configuration page, gated by Sotto Pro. Dictionary is its
own page off the footer: words with a "sounds like" hint and usage counts, a
suggestion row from hand corrections, and snippets that paste whole when you
say "insert" and their name. Type: Bricolage Grotesque. Black only (superseded by ADR-0009, which adds light and accent choices).

### 02 Harbor, `02-harbor.html`

Two berths in a bottom dock, one for each thing Sotto is. The Dictate berth
carries the live wave and state; the Agents berth carries a mini orb and a
session count, so both halves of the app are visible from either page. Dictate
is two columns: the wave and Start on the left, today's transcripts as a reading
list on the right. Agents is the orb on the left and a console on the right with
the session list, the selected transcript, a pinned permission card and the
composer. Type: Instrument Serif for headings and transcripts, Instrument Sans
for UI. Sage palette.

### 03 Spine, `03-spine.html`

A wide left spine with two stacked mode tiles. The Dictate tile shows the live
wave, shortcut and state; the Agents tile shows a mini orb and what needs you.
Dictate's main area is the transcripts themselves, the latest large, with a
floating capsule at the bottom that holds the wave, state and Start. Agents is
the orb on black with a single bottom row: swatches and voice on the left,
sessions in the middle, mute and stop on the right. Permission requests drop in
from the top. Type: Archivo with a condensed width for headings. Dark first,
light variant included.

## Orb lab

`orb-lab.html` is a tuning page for the orb: state buttons, colour presets and
pickers, and sliders for every value in the renderer's TUNE block (mesh density,
lump and ripple frequencies, rim brightness, bloom, fill, dust, camera tilt).
The settings box at the bottom right shows the current values as JSON; paste
them into TUNE in `orb.js` to make them the default for every mockup.

The renderer is a subdivided icosphere displaced by three octaves of 3D Perlin
noise, drawn as additive strokes with bloom computed at quarter resolution.
Density 4 (2562 vertices) is the default; 5 is much denser but roughly twice the
frame cost, which matters once the real app animates it.

## Threads (Crossing)

Every thread Sotto is looking after, on one page, grouped by what you need to
know rather than by project: Needs you, Running, Finished today, then earlier
days. A row is the agent badge, thread title, provider and project, and one
sentence of what is happening now. A row that needs a decision carries the
request inline with Allow and Deny, and the spoken alternative. Opening a row
in place shows how it started, who is managing it and how many follow-ups are
used, the last message, and Open transcript, Pause or Resume managing, Stop
managing. A thread Sotto stopped at the follow-up limit says so plainly. The
Agents room gains an All threads link beside New session, and the third
provider chip is Grok rather than Gemini.
