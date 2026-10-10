// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  MAX_DIAGRAM_SOURCE_LENGTH, inspectDiagramSource, isFenceClosed, stripDiagramConfiguration,
} from '../../../src/shared/diagramSource'
describe('diagram source inspection', () => {
  it('names the drawn kinds and explains everything it does not draw', () => {
    expect(inspectDiagramSource('sequenceDiagram\n  A->>B: hi')).toMatchObject({ kind: 'sequence', label: 'Sequence diagram', problem: null })
    expect(inspectDiagramSource('graph TD\n  A-->B')).toMatchObject({ kind: 'flowchart', label: 'Flowchart' })
    expect(inspectDiagramSource('  %% note\n\nflowchart LR\n  A-->B')).toMatchObject({ kind: 'flowchart' })
    expect(inspectDiagramSource('stateDiagram-v2\n  [*] --> A')).toMatchObject({ kind: 'state', label: 'State diagram' })
    expect(inspectDiagramSource('classDiagram\n  A <|-- B')).toMatchObject({ kind: 'class' })
    expect(inspectDiagramSource('erDiagram\n  A ||--o{ B : has')).toMatchObject({ kind: 'er', label: 'Entity relationship diagram' })
    expect(inspectDiagramSource('pie title Pets\n "Dogs" : 3').problem).toBe('Sotto doesn’t draw “pie” diagrams. Sequence, flow, state, class and entity diagrams are drawn.'.replace('’', "'"))
    expect(inspectDiagramSource('   \n%%{init: {}}%%\n').problem).toBe('This diagram is empty.')
    const long = inspectDiagramSource(`flowchart TD\n${'  A-->B\n'.repeat(MAX_DIAGRAM_SOURCE_LENGTH / 8)}`)
    expect(long).toMatchObject({ kind: null, code: '', problem: 'Too long to draw. Diagrams over 12,000 characters are shown as source.' })
  })

  it('removes directives and front-matter configuration anywhere, keeping only a plain title', () => {
    const source = [
      '﻿---', 'title: "Login ‮flow"', 'config:', '  securityLevel: loose', '  themeCSS: "* { background: url(https://t.example) }"', '---',
      '%%{init: {"securityLevel": "loose"}}%%', 'sequenceDiagram', '  %%{', '  wrap', '  }%%', '  A->>B: hi %%{init: {"theme": "dark"}}%%',
    ].join('\n')
    const { code, title } = stripDiagramConfiguration(source)
    expect(title).toBe('Login flow')
    expect(code).toBe('---\ntitle: "Login flow"\n---\n\nsequenceDiagram\n  \n  A->>B: hi ')
    expect(code).not.toMatch(/securityLevel|themeCSS|%%\{|config:/u)
    expect(inspectDiagramSource(source)).toMatchObject({ kind: 'sequence', title: 'Login flow' })
    // A title line cannot smuggle YAML: it is re-emitted as one JSON string.
    expect(stripDiagramConfiguration('---\ntitle: x\n  config: {securityLevel: loose}\n---\ngraph TD').code).toMatch(/^---\ntitle: "x"\n---\n/u)
  })

  it('treats a fence as complete only once its matching closing fence has arrived', () => {
    expect(isFenceClosed('```mermaid\nflowchart TD\n  A-->B')).toBe(false)
    expect(isFenceClosed('```mermaid\nflowchart TD\n```')).toBe(true)
    expect(isFenceClosed('````mermaid\nflowchart TD\n```')).toBe(false)
    expect(isFenceClosed('```mermaid\nflowchart TD\n~~~')).toBe(false)
    expect(isFenceClosed('~~~mermaid\ngraph TD\n~~~~\n')).toBe(true)
    expect(isFenceClosed('> ```mermaid\n> graph TD\n> ```')).toBe(true)
    expect(isFenceClosed('- ```mermaid\n  graph TD\n  ```')).toBe(true)
    expect(isFenceClosed('```mermaid')).toBe(false)
  })
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
