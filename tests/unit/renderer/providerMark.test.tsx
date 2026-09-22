import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderMark } from '../../../src/renderer/src/agents/ProviderMark'

afterEach(cleanup)

describe('ProviderMark', () => {
  it("draws Devin's devin.ai product mark as one path in a box cropped to it", () => {
    // The owner chose the devin.ai header mark over the Devin app's session icon; the box and the path's opening
    // move are what tell the two apart, so a swap back to the older art fails here rather than in a screenshot.
    const { container } = render(<ProviderMark provider="devin" name="Devin" size={18} />)
    const svg = container.querySelector('svg.provider-mark[data-provider="devin"]')
    expect(svg).not.toBeNull()
    expect(svg).toHaveAttribute('viewBox', '48 48 330 330')
    expect(svg).toHaveAttribute('width', '18')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    const paths = svg!.querySelectorAll('path')
    expect(paths).toHaveLength(1)
    expect(paths[0]!.getAttribute('d')).toMatch(/^M70 159\.333V91\.3471/)
    expect(container.querySelector('.provider-mark--initial')).toBeNull()
  })
  it('falls back to the initial for a provider without a mark', () => {
    const { container } = render(<ProviderMark provider={undefined} name="other client" />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('.provider-mark--initial')).toHaveTextContent('O')
  })
})
