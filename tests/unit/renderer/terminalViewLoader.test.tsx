import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const imports = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../src/renderer/src/tools/terminalView', () => {
  imports.count += 1
  return { createXtermView: () => ({ mounted: true }) }
})

afterEach(() => { cleanup(); vi.resetModules(); imports.count = 0 })

const loader = () => import('../../../src/renderer/src/tools/terminalViewLoader')

describe('the terminal view loader', () => {
  it('hands an injected factory back at once and never imports xterm for it', async () => {
    const { useTerminalViewFactory } = await loader()
    const injected = (() => ({ injected: true })) as unknown as Parameters<typeof useTerminalViewFactory>[0]
    const { result } = renderHook(() => useTerminalViewFactory(injected))
    expect(result.current.factory).toBe(injected)
    expect(imports.count).toBe(0)
  })

  it('loads nothing while no terminal is on screen, then loads once one is', async () => {
    const { useTerminalViewFactory } = await loader()
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useTerminalViewFactory(undefined, enabled), { initialProps: { enabled: false } })
    expect(result.current.factory).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(imports.count).toBe(0)
    rerender({ enabled: true })
    await waitFor(() => expect(result.current.factory).not.toBeNull())
    expect(imports.count).toBe(1)
  })
})
