/**
 * Lighting a visual's step (#793) on what Mermaid 11.17.2 really draws. The SVGs in tests/fixtures/mermaidSteps are
 * Mermaid's own output for one diagram of each kind (capture.mjs makes them again), passed through the same sanitizer
 * the app uses before a step is lit.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DIM_CLASS, LIT_CLASS, diagramStepCss, lightDiagramStep, stepTargets } from '../../../src/renderer/src/agents/diagrams/diagramSteps'
import { toInertDiagramSvg } from '../../../src/renderer/src/agents/diagrams/diagramSvg'

const fixture = (name: string): string => {
  const image = toInertDiagramSvg(readFileSync(join(process.cwd(), 'tests/fixtures/mermaidSteps', `${name}.svg`), 'utf8'))
  if (!image) throw new Error(`${name}.svg did not survive the sanitizer`)
  return image.svg
}
/** The same names in the order lit() reports them. */
const sorted = (names: string[]): string[] => [...names].sort()
const parse = (svg: string): Element => new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement

/** What a step lights, each part named the way a reader would find it: node ids, edge ids, participant names, words. */
function lit(name: string, names: string[]): string[] {
  const root = parse(fixture(name))
  const prefix = `${root.getAttribute('id')}-`
  return [...stepTargets(root, names).lit].map(element => {
    const id = element.getAttribute('id')
    const et = element.getAttribute('data-et')
    if (id && !et) return id.startsWith(prefix) ? id.slice(prefix.length) : id
    const dataId = element.getAttribute('data-id') ?? element.querySelector('[data-id]')?.getAttribute('data-id')
    const kind = et ?? element.getAttribute('class')?.split(' ')[0] ?? element.localName
    return dataId ? `${kind}:${dataId}` : `${kind}:${element.textContent?.trim()}`
  }).sort()
}

describe('a flowchart step', () => {
  it('lights the nodes it names, and the edges between them with their labels', () => {
    expect(lit('flowchart', ['A'])).toEqual(sorted(['flowchart-A-0']))
    expect(lit('flowchart', ['A', 'B'])).toEqual(sorted(['edge:L_A_B_0', 'edge:L_B_A_0', 'edgeLabel:L_A_B_0', 'edgeLabel:L_B_A_0', 'flowchart-A-0', 'flowchart-B-1']))
  })

  it('lights an edge written A->B with its two ends', () => {
    expect(lit('flowchart', ['B->C'])).toEqual(sorted(['edge:L_B_C_0', 'edgeLabel:L_B_C_0', 'flowchart-B-1', 'flowchart-C-3']))
    expect(lit('flowchart', [' B --> A '])).toEqual(sorted(['edge:L_B_A_0', 'edgeLabel:L_B_A_0', 'flowchart-A-0', 'flowchart-B-1']))
  })

  it('lights a subgraph with the nodes inside it and the edges among them', () => {
    expect(lit('flowchart', ['Provider'])).toEqual(sorted(['edge:L_C_D_0', 'edge:L_D_E_0', 'Provider', 'edgeLabel:L_C_D_0', 'edgeLabel:L_D_E_0', 'flowchart-C-3', 'flowchart-D-7', 'flowchart-E-9']))
  })

  it('ignores names it does not know', () => {
    expect(lit('flowchart', ['Draft', 'Z', 'A->Z', 'A'])).toEqual(sorted(['flowchart-A-0']))
  })
})

describe('a sequence step', () => {
  it('lights a participant with its lifeline', () => {
    expect(lit('sequence', ['Codex'])).toEqual(sorted(['life-line:Codex', 'participant:Codex']))
  })

  it('counts arrows from 1, top to bottom, past loops, notes and alternatives', () => {
    // Mermaid's own data-ids are i0, i1, i3, i7, i9 and i11: they count the control rows too.
    expect(lit('sequence', ['3'])).toEqual(sorted(['life-line:Codex', 'life-line:Sotto', 'message:i3', 'messageText:turn/start', 'participant:Codex', 'participant:Sotto']))
    expect(lit('sequence', ['4'])).toEqual(sorted(['life-line:Codex', 'life-line:Sotto', 'message:i7', 'messageText:Accepted', 'participant:Codex', 'participant:Sotto']))
    expect(lit('sequence', ['5'])).toEqual(sorted(['life-line:Sotto', 'message:i9', 'messageText:Reconcile', 'participant:Sotto']))
    expect(lit('sequence', ['6'])).toEqual(sorted(['life-line:Codex', 'life-line:You', 'message:i11', 'messageText:Streams the answer', 'participant:Codex', 'participant:You']))
  })

  it('ignores arrow numbers past the last arrow and names that are not participants', () => {
    expect(lit('sequence', ['0', '7', 'Nobody', 'You->Sotto'])).toEqual(sorted([]))
  })

  it('lights an arrow with its autonumber badge, and a participant with its activation bar', () => {
    expect(lit('sequence-numbered', ['1'])).toEqual(sorted(['life-line:Sotto', 'life-line:You', 'message:i1', 'messageText:Send prompt', 'participant:Sotto', 'participant:You',
      'sequenceNumber:1', 'line:', 'activation0:']))
    expect(lit('sequence-numbered', ['You'])).toEqual(sorted(['life-line:You', 'participant:You']))
    expect(lit('sequence-numbered', ['Sotto'])).toEqual(sorted(['activation0:', 'life-line:Sotto', 'participant:Sotto']))
  })

  it('lights a participant by the name it is drawn with as well as the name it is declared with', () => {
    // participant U as User, participant S as Sotto desktop app
    expect(lit('sequence-aliased', ['User'])).toEqual(sorted(['life-line:U', 'participant:U']))
    expect(lit('sequence-aliased', ['U'])).toEqual(sorted(['life-line:U', 'participant:U']))
    expect(lit('sequence-aliased', [' Sotto  desktop app '])).toEqual(sorted(['life-line:S', 'participant:S']))
  })

  it('dims the notes and control rows a step does not name', () => {
    const root = parse(fixture('sequence'))
    const { parts, lit: shown } = stepTargets(root, ['1'])
    const dimmed = parts.filter(part => !shown.has(part)).map(part => part.getAttribute('data-et')).filter(Boolean)
    expect(dimmed).toEqual(expect.arrayContaining(['note', 'control-structure', 'message', 'participant', 'life-line']))
  })
})

describe('a state step', () => {
  it('lights a state by its id', () => {
    expect(lit('state', ['Idle'])).toEqual(sorted(['state-Idle-4']))
  })

  it('lights a composite state with the states inside it', () => {
    expect(lit('state', ['Running'])).toEqual(sorted(['state-Running-5', 'state-Running_start-2', 'state-Thinking-3', 'state-Writing-3']))
  })
})

describe('a class step', () => {
  it('lights classes by name and the relation between two lit classes', () => {
    expect(lit('class', ['Visual'])).toEqual(sorted(['classId-Visual-2']))
    expect(lit('class', ['Thread', 'Message'])).toEqual(sorted(['classId-Message-1', 'classId-Thread-0', 'edgeLabel:id_Thread_Message_1', 'edge:id_Thread_Message_1']))
    expect(lit('class', ['Thread->Visual'])).toEqual(sorted(['classId-Thread-0', 'classId-Visual-2', 'edgeLabel:id_Thread_Visual_2', 'edge:id_Thread_Visual_2']))
  })
})

describe('an entity relationship step', () => {
  it('lights entities by name and the relationship between two lit entities', () => {
    expect(lit('er', ['MESSAGE'])).toEqual(sorted(['entity-MESSAGE-1']))
    expect(lit('er', ['THREAD', 'VISUAL'])).toEqual(sorted(['edgeLabel:id_entity-THREAD-0_entity-VISUAL-2_1', 'entity-THREAD-0', 'entity-VISUAL-2', 'edge:id_entity-THREAD-0_entity-VISUAL-2_1']))
  })
})

describe('a step picture', () => {
  it('marks the named parts lit and every other part dimmed, without moving anything', () => {
    const base = fixture('flowchart')
    const stepped = lightDiagramStep(base, ['Provider'])!
    const before = parse(base)
    const after = parse(stepped)
    for (const name of ['viewBox', 'width', 'height']) expect(after.getAttribute(name)).toBe(before.getAttribute(name))
    expect(after.querySelectorAll(`.${LIT_CLASS}`)).toHaveLength(8)
    expect([...after.querySelectorAll(`.${DIM_CLASS}`)].map(element => element.getAttribute('class')?.split(' ')[0])).toEqual(expect.arrayContaining(['node', 'edge-thickness-normal', 'edgeLabel']))
    // Only classes were added: the drawing is otherwise the same document.
    const strip = (svg: string): string => svg.replace(new RegExp(` ?(?:${LIT_CLASS}|${DIM_CLASS})`, 'gu'), '').replace(/ class=""/gu, '')
    expect(strip(stepped)).toBe(strip(new XMLSerializer().serializeToString(before)))
  })

  it('leaves the whole drawing lit when a step names nothing it can find', () => {
    for (const name of ['flowchart', 'sequence', 'state', 'class', 'er']) {
      expect(lightDiagramStep(fixture(name), ['Nowhere'])).toBeNull()
      expect(lightDiagramStep(fixture(name), [])).toBeNull()
      expect(lightDiagramStep(fixture(name), undefined)).toBeNull()
    }
  })

  it('styles lit and dimmed parts from the palette alone', () => {
    const css = diagramStepCss({ dark: true, text: '#ffffff', muted: '#aaaaaa', line: '#aaaaaa', node: '#333333', nodeBorder: '#888888', group: '#444444', note: '#222222', block: '#111111', accent: '#70b9ee' })
    expect(css).toContain(`.${DIM_CLASS}{opacity:.3}`)
    expect(css.match(/#[\da-f]{6}/giu)?.every(colour => colour === '#70b9ee')).toBe(true)
    expect(css).not.toMatch(/url\(|@import|@font-face/u)
  })
})
