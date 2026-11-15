/** The still picture a 3D model's line, the page and Tools show (the Meshy plan's tickets 4 and 5). */
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Model3dView } from '../../../../src/shared/models3d'
import { useStill } from '../../../../src/renderer/src/agents/modelParts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const DONE: Model3dView = { id: 'model-1', name: 'Oak barrel', source: 'words', state: 'done', credits: 30, folder: 'models', still: 'Oak barrel.png',
  files: [{ name: 'Oak barrel.png' }, { name: 'Oak barrel.glb' }] }
afterEach(() => { delete (window as { sotto?: unknown }).sotto })

it('reads the still picture again once its file is back', async () => {
  // First listed with its files gone: main hands over no picture.
  const model3dBytes = vi.fn(async (): Promise<Uint8Array | null> => null)
  ;(window as { sotto?: unknown }).sotto = { plugins: { model3dBytes } }
  const { result, rerender } = renderHook(({ view }) => useStill(view), { initialProps: { view: DONE } })
  await waitFor(() => expect(model3dBytes).toHaveBeenCalledTimes(1))
  expect(result.current).toBeUndefined()
  // The files are back.
  model3dBytes.mockResolvedValue(PNG)
  rerender({ view: { ...DONE, files: [{ name: 'Oak barrel.png', bytes: 8 }, { name: 'Oak barrel.glb', bytes: 100 }] } })
  await waitFor(() => expect(result.current).toMatch(/^data:image\/png;base64,/u))
  expect(model3dBytes).toHaveBeenCalledTimes(2)
  // A view that changes nothing about the picture reads nothing more.
  rerender({ view: { ...DONE, credits: 31, files: [{ name: 'Oak barrel.png', bytes: 8 }, { name: 'Oak barrel.glb', bytes: 100 }] } })
  expect(model3dBytes).toHaveBeenCalledTimes(2)
})
