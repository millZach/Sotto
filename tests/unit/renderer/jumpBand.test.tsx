import { afterEach, describe, expect, it } from 'vitest'

import { reachesJumpBand } from '../../../src/renderer/src/agents/ThreadTranscript'

// Jump to latest sits 14px above the transcript's foot, raised by the floating composer's height (threads.css). It steps
// aside while a request card reaches its band, so the band has to be measured from the raised foot too.

function transcript(bottom: number, composer: number, card: { top: number; bottom: number }): HTMLElement {
  const scroller = document.createElement('div')
  scroller.style.scrollPaddingBottom = `${composer}px`
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 600, bottom)
  const request = document.createElement('div')
  request.className = 'agent-request'
  request.getBoundingClientRect = () => new DOMRect(0, card.top, 600, card.bottom - card.top)
  scroller.append(request)
  document.body.append(scroller)
  return scroller
}

afterEach(() => { document.body.replaceChildren() })

describe('the Jump to latest band', () => {
  it('rides above a floating composer, so a card ending behind the composer is under the button', () => {
    // A 500px transcript under a 120px composer: the button's band is 320 to 380.
    expect(reachesJumpBand(transcript(500, 120, { top: 100, bottom: 360 }))).toBe(true)
  })

  it('leaves out a card that lies wholly behind the composer or wholly above the band', () => {
    expect(reachesJumpBand(transcript(500, 120, { top: 400, bottom: 480 }))).toBe(false)
    expect(reachesJumpBand(transcript(500, 120, { top: 100, bottom: 300 }))).toBe(false)
  })

  it('sits at the foot when the composer stacks', () => {
    expect(reachesJumpBand(transcript(500, 0, { top: 100, bottom: 460 }))).toBe(true)
    expect(reachesJumpBand(transcript(500, 0, { top: 100, bottom: 360 }))).toBe(false)
  })

  it('rides above what shows of a slim composer, which keeps the full composer’s padding (ADR-0125)', () => {
    // A 500px transcript keeping 120px for a composer that shows 60px while slim: the band is 380 to 440.
    const scroller = transcript(500, 120, { top: 390, bottom: 420 })
    const pane = document.createElement('section')
    pane.className = 'thread-pane'
    pane.setAttribute('data-slim', '')
    pane.style.setProperty('--thread-compose-shown', '60px')
    pane.append(scroller)
    document.body.append(pane)
    expect(reachesJumpBand(scroller)).toBe(true)
    pane.removeAttribute('data-slim')
    expect(reachesJumpBand(scroller)).toBe(false)
  })
})
