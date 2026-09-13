import { beforeEach, describe, expect, it } from 'vitest'
import mermaid from 'mermaid'
import { readFileSync } from 'node:fs'
import { assertDiagramSafe } from '../../../src/renderer/src/agents/diagrams/diagramSafety'
import { inspectDiagramSource } from '../../../src/renderer/src/agents/diagrams/diagramSource'

beforeEach(() => mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
  maxTextSize: 12000, maxEdges: 300, flowchart: { htmlLabels: false }, class: { htmlLabels: false } }))

async function parsed(source: string) {
  // Intentionally bypass source heuristics here: prove the actual parsed admission boundary.
  return mermaid.mermaidAPI.getDiagramFromText(source)
}
async function denied(source: string, reason = /complex/i) {
  const diagram = await parsed(source) // Invalid syntax must fail the test, not count as safe rejection.
  expect(() => assertDiagramSafe(diagram)).toThrow(reason)
}

it('pins the Mermaid database version audited by these adapters', () => {
  expect(JSON.parse(readFileSync('node_modules/mermaid/package.json', 'utf8')).version).toBe('11.17.2')
  expect(JSON.parse(readFileSync('package.json', 'utf8')).devDependencies.mermaid).toBe('11.17.2')
})

describe('parsed resource metadata', () => {
  for (const key of ['img', '"im\\u0067"', '"\\x69mg"', '"\\U00000069mg"']) {
    it(`denies decoded ${key} before any renderer is invoked`, async () => {
      await denied(`flowchart TD\nA@{ ${key}: "file:///synthetic.svg", label: "Probe" }`, /resources/i)
    })
  }
  it('checks retained metadata across repeated declarations and collapsed groups', async () => {
    await denied('flowchart TD\nA@{ img: "file:///synthetic.svg" }\nA[Ordinary label]', /resources/i)
    await denied('flowchart TD\nsubgraph S\nA@{ img: "file:///synthetic.svg" }\nend\nS@{ view: collapsed }', /resources/i)
    await denied('flowchart TD\nA@{ icon: "logos:github-icon" }', /resources/i)
  })
})

describe('parsed node and connection counts in every admitted kind', () => {
  for (const [kind, source] of [
    ['flow', 'flowchart TD\n' + Array.from({ length: 41 }, (_, i) => `A${i}`).join(';')],
    ['state', 'stateDiagram-v2\n' + Array.from({ length: 41 }, (_, i) => `A${i}: State`).join('\n')],
    ['legacy state', 'stateDiagram\n' + Array.from({ length: 41 }, (_, i) => `A${i}: State`).join('\n')],
    ['class', 'classDiagram\n' + Array.from({ length: 41 }, (_, i) => `class A${i}`).join('\n')],
    ['ER', 'erDiagram\n' + Array.from({ length: 41 }, (_, i) => `A${i}`).join('\n')],
    ['sequence', 'sequenceDiagram\n' + Array.from({ length: 17 }, (_, i) => `participant A${i}`).join('\n')],
  ]) it(`counts ${kind} nodes`, async () => { await denied(source!) })

  for (const [kind, header, edge] of [
    ['flow', 'flowchart TD', 'A-->B'], ['state', 'stateDiagram-v2', 'A-->B'],
    ['class', 'classDiagram', 'A-->B'], ['ER', 'erDiagram', 'A ||--o{ B : owns'],
    ['sequence', 'sequenceDiagram', 'A->>B: message'],
  ]) it(`counts ${kind} connections, including parallel edges`, async () => {
    await denied(`${header}\n${Array.from({ length: 61 }, () => edge).join('\n')}`)
  })
  it('counts compact Cartesian flow edges and rank-span work', async () => {
    await denied('flowchart TD\nA & B & C & D & E & F & G & H --> I & J & K & L & M & N & O & P')
    await denied('flowchart TD\nA ----------> B')
  })
  it('bounds dense graphs even below separate node/edge ceilings', async () => {
    const source = 'stateDiagram-v2\n' + Array.from({ length: 30 }, (_, i) => `A${i}-->A${(i + 1) % 30}\nA${i}-->A${(i + 2) % 30}`).join('\n')
    await denied(source)
  })
})

describe('nesting and label work', () => {
  it('bounds nested flow groups', async () => {
    await denied('flowchart TD\nsubgraph A\nsubgraph B\nsubgraph C\nsubgraph D\nE\nend\nend\nend\nend')
  })
  it('bounds nested states', async () => {
    await denied('stateDiagram-v2\nstate A {\nstate B {\nstate C {\nstate D {\nE --> F\n}\n}\n}\n}')
  })
  it('bounds implicit dotted class namespaces', async () => {
    await denied('classDiagram\nnamespace A.B.C.D {\nclass E\n}')
  })
  it('bounds nested ER groups', async () => {
    await denied('erDiagram\nsubgraph A\nsubgraph B\nsubgraph C\nsubgraph D\nE\nend\nend\nend\nend')
  })
  it('bounds sequence blocks and activation depth', async () => {
    await denied('sequenceDiagram\nloop one\nloop two\nloop three\nloop four\nA->>B: hi\nend\nend\nend\nend')
    await denied('sequenceDiagram\nparticipant A\nactivate A\nactivate A\nactivate A\nactivate A\ndeactivate A\ndeactivate A\ndeactivate A\ndeactivate A')
  })
  it('admits sibling critical blocks and options without treating options as block endings', async () => {
    const diagram = await parsed('sequenceDiagram\ncritical First request\nA->>B: Send\noption Retry\nA->>B: Again\noption Stop\nB-->>A: Stop\nend\ncritical Second request\nA->>B: Send\nend')
    expect(() => assertDiagramSafe(diagram)).not.toThrow()
  })
  it('bounds a single huge label and many class/ER rows', async () => {
    await denied(`flowchart TD\nA[${'x'.repeat(401)}]`)
    await denied('classDiagram\nclass A {\n' + Array.from({ length: 121 }, (_, i) => `+String member${i}`).join('\n') + '\n}')
    await denied('erDiagram\nA {\n' + Array.from({ length: 121 }, (_, i) => `string member${i}`).join('\n') + '\n}')
  })
  it('counts ER display aliases in the per-label and total text budgets', async () => {
    await denied(`erDiagram\nA["${'x'.repeat(401)}"]`)
    await denied('erDiagram\n' + Array.from({ length: 14 }, (_, i) => `A${i}["${'x'.repeat(300)}"]`).join('\n'))
  })
})

it('admits ordinary grouped, annotated and styled examples', async () => {
  for (const source of [
    'flowchart LR\nsubgraph Group\nA[Start] --> B{Ready}\nend\nB --> C[Done]\nclassDef good fill:#eee,stroke:#333\nclass A good',
    'sequenceDiagram\nparticipant A\nparticipant B\nloop retry\nA->>+B: Send\nB-->>-A: Done\nend\nNote over A,B: Finished',
    'sequenceDiagram\nA->>+B: Still active',
    'stateDiagram-v2\n[*] --> Idle\nstate Running {\n[*] --> Waiting\nWaiting --> Done\n}\nIdle --> Running',
    'classDiagram\nnamespace Animals {\nclass Duck {\n+String name\n+fly()\n}\n}\nAnimal <|-- Duck',
    'erDiagram\nCUSTOMER {\nstring name\nint id PK\n}\nCUSTOMER ||--o{ ORDER : places',
  ]) {
    const diagram = await parsed(source)
    expect(() => assertDiagramSafe(diagram), source).not.toThrow()
  }
})

it('fails closed for an unknown database/type', () => {
  expect(() => assertDiagramSafe({ type: 'future-kind', db: {} })).toThrow(/cannot be checked/i)
})

it('reinspection keeps quoted titles stable while stripping configuration', () => {
  const source = '---\ntitle: "Quoted \\"title\\" and \\\\ slash"\nconfig:\n  securityLevel: loose\n---\nflowchart TD\nA --> B'
  const once = inspectDiagramSource(source)
  const twice = inspectDiagramSource(once.code)
  expect(twice).toEqual(once)
  expect(twice.code).not.toContain('securityLevel')
})

it('bounds dense-state and 1000-node parser work independently of source length', () => {
  const state = 'stateDiagram-v2\n' + Array.from({ length: 40 }, (_, i) =>
    Array.from({ length: 39 - i }, (_, j) => `A${i}-->A${i + j + 1}`).join('\n')).join('\n')
  const nodes = 'flowchart TD\n' + Array.from({ length: 1000 }, (_, i) => `A${i}`).join('\n')
  for (const source of [state, nodes, state.replaceAll('\n', ';')]) {
    expect(source.length).toBeLessThan(12000)
    expect(inspectDiagramSource(source).problem).toMatch(/parser work limit/i)
  }
})
