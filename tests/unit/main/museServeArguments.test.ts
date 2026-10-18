// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { museServeArguments } from '../../../src/main/agents/muse'

describe('muse serve arguments', () => {
  it('keeps the shell sandbox unless told to start without it', () => {
    expect(museServeArguments()).toEqual(['serve'])
    expect(museServeArguments(false)).toEqual(['serve'])
    expect(museServeArguments(true)).toEqual(['serve', '--disable-sandbox'])
  })
})
