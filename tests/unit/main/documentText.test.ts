// @vitest-environment jsdom
/**
 * The page-side read behind `showsSecret` (after the third review of the browser-parity branch), run in a DOM: on a page
 * a secret was typed into, a later document that shows it again is found by its words, its fields, its open shadow
 * roots and its same-origin frames, so Sotto takes no picture of it and selects none of its text.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { DOCUMENT_TEXT } from '../../../src/main/tools/pageAutomation'

const read = (): string => (0, eval)(DOCUMENT_TEXT) as string

afterEach(() => { document.body.replaceChildren() })

describe('the words and fields of a document, as Sotto reads them to find a secret written back', () => {
  it('reads the words, and what each field holds that no word says', () => {
    document.body.innerHTML = '<p>Saved.</p><input id="key"><textarea id="note"></textarea><select><option>Plan words-in-option</option></select>'
    ;(document.getElementById('key') as HTMLInputElement).value = 'value-in-input'
    ;(document.getElementById('note') as HTMLTextAreaElement).value = 'value-in-textarea'
    const text = read()
    for (const part of ['Saved.', 'value-in-input', 'value-in-textarea', 'words-in-option']) expect(text).toContain(part)
  })

  it('follows open shadow roots, one inside another, and their fields', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<span>words-in-shadow</span><input><div id="inner"></div>'
    root.querySelector('input')!.value = 'value-in-shadow'
    const deeper = root.getElementById('inner')!.attachShadow({ mode: 'open' })
    deeper.innerHTML = '<b>words-two-roots-down</b>'
    const text = read()
    for (const part of ['words-in-shadow', 'value-in-shadow', 'words-two-roots-down']) expect(text).toContain(part)
  })

  it('follows a same-origin frame, its words and its fields', () => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const inner = frame.contentDocument!
    inner.body.innerHTML = '<p>words-in-frame</p><input>'
    inner.querySelector('input')!.value = 'value-in-frame'
    const text = read()
    for (const part of ['words-in-frame', 'value-in-frame']) expect(text).toContain(part)
  })

  it('reads a document with no body, and gives a string', () => {
    document.body.remove()
    expect(typeof read()).toBe('string')
    document.documentElement.append(document.createElement('body'))
  })
})
