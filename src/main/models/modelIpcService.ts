import type { ModelDisclosureCatalog, ModelInstallRequest, ModelStatus } from '../../shared/contracts'
import type { ModelPreset } from '../../shared/settings'
import type { ModelIpcService } from '../ipc/registerIpc'

interface ModelOperations {
  disclosures(): ModelDisclosureCatalog
  status(preset: ModelPreset): Promise<ModelStatus>
  install(preset: ModelPreset, input: { readonly consent: boolean }): Promise<void>
  remove(preset: ModelPreset): Promise<void>
}

export function createModelIpcService(
  models: ModelOperations,
  publish: (status: ModelStatus) => void | Promise<void>,
): ModelIpcService {
  const publishSafely = async (status: ModelStatus): Promise<void> => {
    try { await publish(Object.freeze({ ...status })) } catch { /* status delivery is observational */ }
  }
  const run = async (preset: ModelPreset, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation()
    } catch (error) {
      await publishSafely({ preset, state: 'error' })
      throw error
    }
    try {
      const status = await models.status(preset)
      await publishSafely(status.state === 'downloading' ? { preset, state: 'error' } : status)
    } catch {
      await publishSafely({ preset, state: 'error' })
    }
  }
  const service: ModelIpcService = {
    listDisclosures: () => models.disclosures(),
    getStatus: (preset: ModelPreset) => models.status(preset),
    install: (request: ModelInstallRequest) => run(request.preset, () => models.install(request.preset, { consent: request.consent })),
    remove: (preset: ModelPreset) => run(preset, () => models.remove(preset)),
  }
  return Object.freeze(service)
}
