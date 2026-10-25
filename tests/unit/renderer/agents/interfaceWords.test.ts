import { i18n, type MessageDescriptor } from '@lingui/core'
import { afterEach, describe, expect, it } from 'vitest'
import { leftToRight, shownWords } from '../../../../src/renderer/src/agents/interfaceWords'

const place: MessageDescriptor = { id: 'test.place', message: 'this computer' }
const unreadable = (folder: string): MessageDescriptor =>
  ({ id: 'test.unreadable', message: 'Sotto can’t read {folder} on {place}.', values: { folder, place } })

afterEach(() => { i18n.loadAndActivate({ locale: 'en', messages: {} }) })

describe('words the Threads page keeps to show later', () => {
  it('shows text someone else wrote as written, and a message in the language shown now', () => {
    const kept = unreadable('src')
    expect(shownWords('forge is disconnected.')).toBe('forge is disconnected.')
    expect(shownWords(null)).toBeNull()
    expect(shownWords(kept)).toBe('Sotto can’t read src on this computer.')
    // The same kept message, read again after a change of language, is reworded, the message inside it too.
    i18n.loadAndActivate({ locale: 'fr', messages: { 'test.place': 'cet ordinateur', 'test.unreadable': 'Sotto ne peut pas lire {folder} sur {place}.' } })
    expect(shownWords(kept)).toBe('Sotto ne peut pas lire src sur cet ordinateur.')
  })

  it('keeps a branch name in its own left-to-right isolate only in a right-to-left language', () => {
    expect(leftToRight('feat/a-b')).toBe('feat/a-b')
    i18n.loadAndActivate({ locale: 'ar', messages: {} })
    expect(leftToRight('feat/a-b')).toBe('⁦feat/a-b⁩')
  })
})
