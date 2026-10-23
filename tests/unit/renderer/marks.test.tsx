import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Mark, Marked, useMark } from '../../../src/renderer/src/components/marks'

afterEach(cleanup)

function Surface({ children }: { readonly children?: React.ReactNode }): React.ReactNode {
  return <Marked>{marks => <section data-testid="surface" {...marks}>{children}</section>}</Marked>
}

function Teller({ name, value }: { readonly name: string; readonly value: string | boolean | null }): React.ReactNode {
  useMark(name, value)
  return null
}

describe('marks', () => {
  it('wears what a part tells, with its value, and takes it off when the part withdraws it or leaves', () => {
    const { getByTestId, rerender, unmount } = render(<Surface><Teller name="tools" value="docked" /><Teller name="greeting" value /></Surface>)
    expect(getByTestId('surface').getAttribute('data-tools')).toBe('docked')
    expect(getByTestId('surface').getAttribute('data-greeting')).toBe('')
    rerender(<Surface><Teller name="tools" value="overlay" /><Teller name="greeting" value={false} /></Surface>)
    expect(getByTestId('surface').getAttribute('data-tools')).toBe('overlay')
    expect(getByTestId('surface').hasAttribute('data-greeting')).toBe(false)
    rerender(<Surface><Teller name="greeting" value={null} /></Surface>)
    expect(getByTestId('surface').hasAttribute('data-tools')).toBe(false)
    unmount()
  })

  it('keeps a mark while any of several parts holds it', () => {
    const { getByTestId, rerender } = render(<Surface><Mark name="request" /><Teller name="request" value /></Surface>)
    expect(getByTestId('surface').hasAttribute('data-request')).toBe(true)
    rerender(<Surface><Teller name="request" value /></Surface>)
    expect(getByTestId('surface').hasAttribute('data-request')).toBe(true)
    rerender(<Surface><Teller name="request" value={false} /></Surface>)
    expect(getByTestId('surface').hasAttribute('data-request')).toBe(false)
  })

  it('reaches the nearest surface only, and is quiet with none', () => {
    const { getAllByTestId } = render(<Surface><Surface><Teller name="questions" value /></Surface></Surface>)
    const [outer, inner] = getAllByTestId('surface')
    expect(inner!.hasAttribute('data-questions')).toBe(true)
    expect(outer!.hasAttribute('data-questions')).toBe(false)
    expect(() => render(<Teller name="alone" value />)).not.toThrow()
  })
})
