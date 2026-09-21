# What the window loads before it can draw

The renderer's main chunk is parsed before the first frame. Measured from `npm run build` output
(`out/renderer/assets/main-*.js`), bytes on disk and gzip, Windows 11.

## Before

| Chunk | Bytes | gzip |
| --- | ---: | ---: |
| `main-*.js` | 2,396,693 | 544,206 |

Two libraries rode in it that nothing draws at start. `@xterm/xterm` with its fit and WebGL addons is
used once a terminal is open, in the Tools panel or in Terminal mode. lowlight's `common` grammar set,
thirty-seven languages, is used once a fenced code block that names a language is rendered. Someone who
opens Sotto to dictate paid for both on every launch. Mermaid was already loaded with the first diagram
(`MermaidDiagram.tsx`); that is the pattern both now follow.

## After

| Chunk | Bytes | gzip |
| --- | ---: | ---: |
| `main-*.js` | 1,489,651 | 329,905 |
| `terminalView-*.js` (xterm, on first terminal) | 569,420 | 129,677 |
| `index-*.js` (lowlight and highlight.js, on first highlighted block) | 336,136 | 84,386 |

The startup chunk is 907 kB smaller, 214 kB gzipped. Both lazy chunks load from disk inside the app
archive, so the first terminal and the first highlighted block wait a few milliseconds for a module,
not for the network.

What the user sees while a chunk loads: the terminal frame with an empty screen marked busy, and a code
block with its text, bar and copy control, unhighlighted until the grammars arrive. Nothing is announced.
Tests that inject their own terminal view are unchanged; the highlighter tests wait for the import.

`bundled-dependencies.json` still names every package in the lazy chunks, so the release notices check
(`npm run notices:verify`) sees the same inventory it did.
