import type { AgentModel } from '../../../shared/agents'
import { isRoleDefault, roleInForce, type WorkerRoleChoices } from '../../../shared/workerRoles'
import { useOptionalApp } from '../state/AppContext'
import { useOwlFeature } from '../state/owlFeature'

/**
 * Orchestrating is Watcher's own model and effort (#1041): one choice, shown on Watcher's composer chips and on the
 * Orchestrating card in Settings, under Watcher. A change in either place saves it here, so the next Watcher starts on it;
 * a row back on the role's default stops being a choice and follows the defaults again. Null where worker roles are off.
 */
export function useSaveOrchestrating(): ((modelId: string, reasoningEffort: string | null, models: readonly AgentModel[]) => void) | null {
  const app = useOptionalApp()
  const enabled = useOwlFeature('worker-roles')
  if (!enabled || app === null || app.settings === null) return null
  const { actions } = app, saved = app.settings.workerRoles
  return (modelId, reasoningEffort, models) => {
    const row = { modelId, reasoningEffort }
    const now = saved.orchestrating
    if (now && now.modelId === row.modelId && now.reasoningEffort === row.reasoningEffort) return
    const next: WorkerRoleChoices = { ...saved }
    if (isRoleDefault('orchestrating', row, models)) delete next.orchestrating
    else next.orchestrating = row
    if (next.orchestrating === undefined && now === undefined) return
    void actions.updateSettings({ workerRoles: next })
  }
}

/** What Watcher's first message starts it on: the Orchestrating role's model and effort, where worker roles are on. */
export function useOrchestratingStart(models: readonly AgentModel[]): { readonly modelId: string; readonly reasoningEffort: string | null } | null {
  const app = useOptionalApp()
  const enabled = useOwlFeature('worker-roles')
  if (!enabled || app === null || app.settings === null) return null
  const start = roleInForce('orchestrating', app.settings.workerRoles, models).start
  return start ? { modelId: start.modelId, reasoningEffort: start.reasoningEffort } : null
}
