// Captures what Mermaid 11.17.2 draws for one diagram of each kind a visual's steps can light, with the settings the
// app's renderer uses, so the unit tests find step targets in real output rather than in hand-written SVG.
// Run with `node tests/fixtures/mermaidSteps/capture.mjs` after a Mermaid upgrade, then check the tests still pass.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')

export const SOURCES = {
  flowchart: [
    'flowchart LR',
    '  A[Draft] --> B{Ready?}',
    '  B -->|yes| C[Send]',
    '  B -->|no| A',
    '  subgraph Provider',
    '    C --> D[Codex]',
    '    D --> E[Reply]',
    '  end',
    '  E --> A',
  ].join('\n'),
  sequence: [
    'sequenceDiagram',
    '  participant You',
    '  participant Sotto',
    '  participant Codex',
    '  You->>Sotto: Send prompt',
    '  Sotto-->>You: Shows it as sending',
    '  loop Until accepted',
    '    Sotto->>Codex: turn/start',
    '  end',
    '  Note over Sotto,Codex: Checked, never sent twice',
    '  alt Accepted',
    '    Codex-->>Sotto: Accepted',
    '  else Dropped',
    '    Sotto->>Sotto: Reconcile',
    '  end',
    '  Codex-->>You: Streams the answer',
  ].join('\n'),
  'sequence-numbered': [
    'sequenceDiagram',
    '  autonumber',
    '  actor You',
    '  participant Sotto',
    '  You->>+Sotto: Send prompt',
    '  Sotto-->>-You: Shows it as sending',
  ].join('\n'),
  'sequence-aliased': [
    'sequenceDiagram',
    '  participant U as User',
    '  participant S as Sotto desktop app',
    '  U->>S: Send prompt',
  ].join('\n'),
  'flowchart-nested': [
    'flowchart LR',
    '  subgraph Outer',
    '    A[Draft] --> B[Check]',
    '    subgraph Inner',
    '      C[Send] --> D[Wait]',
    '    end',
    '  end',
    '  B --> C',
    '  D --> E[Reply]',
  ].join('\n'),
  state: [
    'stateDiagram-v2',
    '  [*] --> Idle',
    '  Idle --> Running: send',
    '  state Running {',
    '    [*] --> Thinking',
    '    Thinking --> Writing',
    '  }',
    '  Running --> Idle: done',
    '  Running --> Failed: error',
    '  Failed --> [*]',
  ].join('\n'),
  class: [
    'classDiagram',
    '  class Thread {',
    '    +id string',
    '    +send(text)',
    '  }',
    '  class Message',
    '  class Visual',
    '  Thread "1" *-- "many" Message : holds',
    '  Thread --> Visual : draws',
  ].join('\n'),
  er: [
    'erDiagram',
    '  THREAD ||--o{ MESSAGE : holds',
    '  THREAD ||--o{ VISUAL : draws',
    '  VISUAL {',
    '    string id',
    '    string title',
    '  }',
  ].join('\n'),
}

const CONFIG = {
  startOnLoad: false, securityLevel: 'strict', deterministicIds: false, htmlLabels: false, theme: 'base',
  fontFamily: 'sans-serif', fontSize: 15,
  flowchart: { htmlLabels: false, useMaxWidth: false },
  sequence: { useMaxWidth: false, wrap: true, mirrorActors: false },
  state: { useMaxWidth: false },
  class: { htmlLabels: false, useMaxWidth: false },
  er: { useMaxWidth: false },
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.setContent('<!doctype html><body></body>')
  await page.addScriptTag({ content: await readFile(join(root, 'node_modules/mermaid/dist/mermaid.min.js'), 'utf8') })
  for (const [name, source] of Object.entries(SOURCES)) {
    const svg = await page.evaluate(async ({ source, config, id }) => {
      globalThis.mermaid.initialize(config)
      return (await globalThis.mermaid.render(id, source)).svg
    }, { source, config: CONFIG, id: `sotto-diagram-${name}` })
    await writeFile(join(here, `${name}.svg`), svg)
  }
} finally { await browser.close() }
