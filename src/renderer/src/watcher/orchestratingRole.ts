import type { AgentModel, AgentSpeed } from '../../../shared/agents'
import { roleInForce, withRoleRow } from '../../../shared/workerRoles'
import { useOptionalApp } from '../state/AppContext'
import { useOwlFeature } from '../state/owlFeature'

/**
 * Orchestrating is Watcher's own model, effort and speed (#1041, ADR-0091): one choice, shown on Watcher's composer chips
 * and on the Orchestrating card in Settings, under Watcher. A change in either place saves it here, so the next Watcher
 * starts on it; a row back on the role's default stops being a choice and follows the defaults again. A speed left out
 * keeps the saved one. Null where worker roles are off.
 */
export function useSaveOrchestrating(): ((modelId: string, reasoningEffort: string | null, models: readonly AgentModel[], speed?: AgentSpeed | null) => void) | null {
  const app = useOptionalApp()
  const enabled = useOwlFeature('worker-roles')
  if (!enabled || app === null || app.settings === null) return null
  const { actions } = app, saved = app.settings.workerRoles
  return (modelId, reasoningEffort, models, speed) => {
    const now = saved.orchestrating
    const kept = speed !== undefined ? speed : now?.speed ?? null
    const row = { modelId, reasoningEffort, ...(kept ? { speed: kept } : {}) }
    if (now && now.modelId === row.modelId && now.reasoningEffort === row.reasoningEffort && (now.speed ?? null) === kept) return
    const next = withRoleRow(saved, 'orchestrating', row, models)
    if (next.orchestrating === undefined && now === undefined) return
    void actions.updateSettings({ workerRoles: next })
  }
}

/** The saved choice, before a model fits it; undefined lets an existing Watcher keep its own choice. */
export function useOrchestratingSpeed(): AgentSpeed | null | undefined {
  const app = useOptionalApp()
  const enabled = useOwlFeature('worker-roles')
  const choice = enabled ? app?.settings?.workerRoles.orchestrating : undefined
  return choice ? choice.speed ?? null : undefined
}

/** What Watcher's first message starts it on: the Orchestrating role's model, effort and speed, where worker roles are on. */
export function useOrchestratingStart(models: readonly AgentModel[]): { readonly modelId: string; readonly reasoningEffort: string | null; readonly speed: AgentSpeed | null } | null {
  const app = useOptionalApp()
  const enabled = useOwlFeature('worker-roles')
  if (!enabled || app === null || app.settings === null) return null
  const start = roleInForce('orchestrating', app.settings.workerRoles, models).start
  return start ? { modelId: start.modelId, reasoningEffort: start.reasoningEffort, speed: start.speed } : null
}
