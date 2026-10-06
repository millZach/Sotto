import React, { useLayoutEffect, useRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfirmationDialog } from '../../../src/renderer/src/components/ConfirmationDialog'

afterEach(cleanup)

it('gives an opening host-key question focus before its committed view is used', () => {
  const opened = vi.fn()
  function Question() {
    const key = useRef<HTMLPreElement>(null)
    useLayoutEffect(() => { opened(document.activeElement) }, [])
    return <ConfirmationDialog title="Trust host?" description={<pre ref={key} tabIndex={0} role="region" aria-label="SSH host key">Synthetic host key</pre>}
      initialFocus={key} confirmLabel="Trust host" cancelLabel="Not now" onConfirm={async () => undefined} onCancel={() => undefined} />
  }
  render(<Question />)
  expect(opened).toHaveBeenCalledExactlyOnceWith(screen.getByRole('region', { name: 'SSH host key' }))
})
