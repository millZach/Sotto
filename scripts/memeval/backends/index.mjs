// Register additional backend factories here; the harness stays unchanged.
import { createBackend as createNoneBackend } from './none.mjs'

const factories = new Map([
  ['none', createNoneBackend],
  ['explicit', async () => (await import('./explicit.mjs')).createBackend()],
])

export function createBackend(name) {
  const factory = factories.get(name)
  if (!factory) throw new Error(`Unknown backend: ${name}. Available backends: ${[...factories.keys()].join(', ')}`)
  return factory()
}
