import { vi } from 'vitest'

/** Import inside an async vi.mock factory, which executes before ordinary imports initialize. */
export function preloadElectron() {
  return {
    contextBridge: { exposeInMainWorld: vi.fn() },
    ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  }
}
