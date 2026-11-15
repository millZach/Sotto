import React, { useId, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import type { AgentThread, ProviderId, RouterPick } from '../../../shared/agents'
import { isDynamicThread } from '../../../shared/dynamicThreads'
import { DEFAULT_MODEL_ROUTER, isRoutedThread, whyNotRouted, type ModelRouterSettings } from '../../../shared/modelRouter'
import { Toggle } from '../components/Toggle'
import { useOptionalApp } from '../state/AppContext'
import { useOwlFeature } from '../state/owlFeature'
import type { AgentConnection } from './AgentContext'
import { effortLabel } from './effortNames'

/**
 * Model routing for one thread (ADR-0207): the switch at the foot of its model menu, under Dynamic's, and what the chip
 * needs to show it. Nothing here exists where the Owl feature is off or on a thread that cannot be routed. A Dynamic
 * thread shows the switch fixed, with why. It asks nothing on first use: the classifier is the thread's own Claude Code.
 */
export function useRouterSwitch({ thread, picks, command }: {
  readonly thread: AgentThread; readonly picks: readonly RouterPick[] | undefined; readonly command: AgentConnection['command']
}): {
  readonly routed: boolean
  /** The thread's last routing, where main holds one. */
  readonly pick: RouterPick | undefined
  readonly cardId: string
  readonly foot: (() => ReactNode) | undefined
  /** Turns routing off, which a model pressed by hand does first so the press is never overridden. */
  readonly turnOff: () => void
} {
  const { t } = useLingui()
  const enabled = useOwlFeature('model-router')
  const dynamic = isDynamicThread(thread, useOwlFeature('dynamic-threads'))
  const cardId = useId()
  const routed = isRoutedThread(thread, enabled)
  const set = (next: boolean): void => { void command({ type: 'set-thread-routed', threadId: thread.id, routed: next }) }
  // Offered wherever the thread could be routed were it not Dynamic, so a Dynamic thread's menu says why it is fixed.
  const offered = enabled && whyNotRouted({ ...thread, dynamic: undefined }) === undefined
  return { routed, cardId, pick: routed ? picks?.find(item => item.threadId === thread.id) : undefined, turnOff: () => set(false),
    foot: !offered ? undefined : () => <Toggle label={t`Model routing`} checked={routed} disabled={dynamic}
      {...dynamic ? { description: t`Turn Dynamic off to use model routing.` } : {}} onCheckedChange={set} /> }
}

/**
 * Model routing for every new Claude Code thread (ADR-0207): the switch at the foot of the model menu in Settings' New
 * threads start with row. It is kept while another provider's model is the default, and gives way where new threads
 * start Dynamic.
 */
export function useNewThreadsRouterSwitch({ provider }: { readonly provider: ProviderId | undefined }): { readonly routing: boolean; readonly foot: (() => ReactNode) | undefined } {
  const { t } = useLingui()
  const enabled = useOwlFeature('model-router')
  const dynamicOn = useOwlFeature('dynamic-threads')
  const app = useOptionalApp()
  const saved: ModelRouterSettings = app?.settings?.modelRouter ?? DEFAULT_MODEL_ROUTER
  const offered = enabled && provider === 'claude'
  const dynamic = dynamicOn && app?.settings?.dynamicThreads?.newThreads === true
  const routing = offered && saved.newThreads === true && !dynamic
  return { routing, foot: !offered ? undefined : () => <Toggle label={t`Model routing`} checked={routing} disabled={dynamic}
    {...dynamic ? { description: t`New threads start Dynamic. Turn Dynamic off to start them with model routing.` } : {}}
    onCheckedChange={next => { void app?.actions.updateSettings({ modelRouter: { stayOnFirstModel: saved.stayOnFirstModel, ...next ? { newThreads: true } : {} } }) }} /> }
}

/** What the model chip's card says of a routed thread's last routing, under the model's name. */
export function RouterPickCard({ pick, modelName, effort }: { readonly pick: RouterPick; readonly modelName: string; readonly effort: string }): ReactNode {
  const { t } = useLingui()
  const level = effort ? effortLabel(effort) : t`Provider default`
  const words = pick.state === 'failed' ? t`Model routing did not answer. Sent on ${modelName}, ${level}.`
    : pick.state === 'unconfirmed' ? t`Claude Code did not confirm the model change. The chips show what this thread runs on.`
    : pick.state === 'kept' ? t`Model routing kept ${modelName}, ${level}.`
    : t`Model routing chose ${modelName}, ${level}.`
  return <><p className="model-picker__card-name">{words}</p>{pick.reason && pick.state !== 'failed' ? <p className="model-picker__card-name">{pick.reason}</p> : null}</>
}
