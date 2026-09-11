import { MemoryStore } from './store'

export function openRuntimeMemory(
  path: string,
  log: (event: 'memory-store-open-failed') => void,
): MemoryStore | undefined {
  try {
    const store = new MemoryStore(path)
    store.open()
    return store
  } catch {
    log('memory-store-open-failed')
    return undefined
  }
}
