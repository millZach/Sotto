import type { Page } from '@playwright/test'

/**
 * Every line drawn round a pane's composer, in words: a border with any colour, an outline, a box shadow or a pseudo
 * element's ring on the composer, its card or the card's field (ADR-0110: the composer has no edge in any state).
 * Empty when there is none. The card's border stays, transparent, so the card keeps its size.
 */
export async function composerEdges(page: Page, pane: string): Promise<string[]> {
  return page.evaluate(pane => {
    const compose = document.querySelector<HTMLElement>(`${pane} > .thread-workspace__compose`)
    const card = compose?.querySelector<HTMLElement>(':scope > .thread-prompt')
    if (compose == null || card == null) return ['no composer']
    const pixel = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const alpha = (css: string): number => { pixel.clearRect(0, 0, 1, 1); pixel.fillStyle = 'rgba(0, 0, 0, 0)'; pixel.fillStyle = css; pixel.fillRect(0, 0, 1, 1); return pixel.getImageData(0, 0, 1, 1).data[3]! }
    const found: string[] = []
    const parts: Array<[string, Element]> = [['composer', compose], ['card', card], ...[...card.querySelectorAll('.prompt-editor, textarea, .screenshot-input')].map(node => [node.className.toString().split(' ')[0] ?? 'field', node] as [string, Element])]
    for (const [name, node] of parts) {
      for (const pseudo of [null, '::before', '::after'] as const) {
        const style = getComputedStyle(node, pseudo)
        const where = `${name}${pseudo ?? ''}`
        if (pseudo !== null && (style.content === 'none' || style.content === 'normal')) continue
        for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
          const width = parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`))
          if (width > 0 && style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none' && alpha(style.getPropertyValue(`border-${side.toLowerCase()}-color`)) > 0) found.push(`${where} border ${side.toLowerCase()} ${style.getPropertyValue(`border-${side.toLowerCase()}-color`)}`)
        }
        if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && alpha(style.outlineColor) > 0) found.push(`${where} outline ${style.outlineColor}`)
        if (style.boxShadow !== 'none') found.push(`${where} shadow ${style.boxShadow}`)
        // A ring drawn as a masked gradient round the card, as the highest effort's was.
        if (pseudo === '::after' && style.backgroundImage !== 'none' && style.opacity !== '0') found.push(`${where} ring ${style.backgroundImage.slice(0, 40)}`)
      }
    }
    return found
  }, pane)
}
