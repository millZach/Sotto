import React, { useRef, useState, type ReactNode } from 'react'
import { t as translate } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { AgentState, AgentThread, ProviderId } from '../../../shared/agents'
import { DEFAULT_DYNAMIC_THREADS, DYNAMIC_OVERSEERS, isDynamicThread, PROVIDER_COMPANIES, whyNotDynamic, type DynamicThreadSettings } from '../../../shared/dynamicThreads'
import { reportsUsageLimits } from '../../../shared/usageDashboard'
import { ConfirmationDialog } from '../components/ConfirmationDialog'
import { Toggle } from '../components/Toggle'
import { useOptionalApp } from '../state/AppContext'
import { useOwlFeature } from '../state/owlFeature'
import type { AgentConnection } from './AgentContext'

/** What the allowed list starts as: the connected providers that report their limits, since one that does not would be chosen blind (ADR-0191). */
export function firstAllowedProviders(state: AgentState): ProviderId[] {
  const ready = new Set(state.host.models.filter(model => model.ready && model.providerId).map(model => model.providerId!))
  return [...ready].filter(provider => reportsUsageLimits(provider))
}

/** Who a provider's work goes to, in the allowed list's words. OpenCode is a client, and what it reaches is whichever model source the model runs on. */
export function companyWords(provider: ProviderId): string {
  return provider === 'opencode' ? translate({ message: 'OpenCode\'s model sources', comment: 'Who an OpenCode thread\'s work goes to, in a list of companies such as Anthropic and OpenAI.' }) : PROVIDER_COMPANIES[provider]
}

/**
 * The question the first turn-on asks: it names the companies the allowed list would send work to, and the answer makes that
 * list. **Choose providers** opens the list in Settings and turns nothing on.
 */
function FirstUseQuestion({ title, modelName, providers, turnOn, onDismiss }: {
  readonly title: string; readonly modelName: string; readonly providers: readonly ProviderId[]
  /** Makes the list and turns Dynamic on, answering false when it could not. */
  readonly turnOn: () => Promise<boolean>
  readonly onDismiss: () => void
}): ReactNode {
  const { t } = useLingui()
  const app = useOptionalApp()
  const confirmed = useRef(false)
  const companies = providers.map(companyWords).join(', ')
  return <ConfirmationDialog danger={false} confirmFirst initialFocus="confirm" title={title} confirmLabel={t`Turn on`} cancelLabel={t`Choose providers`}
    description={<>{t`${modelName} will choose a model for each piece, and your code can go to any company on your list: ${companies}.`} {t`You only see this once. The list stays in Settings, under Threads.`}</>}
    onDismiss={onDismiss}
    onConfirm={async () => {
      confirmed.current = true
      if (!await turnOn()) { confirmed.current = false; return false }
      return true
    }}
    // The dialog closes through this after a confirm too, so only the other button goes on to the list, which turns nothing on.
    onCancel={() => {
      onDismiss()
      if (confirmed.current) { confirmed.current = false; return }
      app?.actions.navigate('settings', 'settings-agents', 'dynamic-threads')
    }} />
}

/**
 * Dynamic for every new thread (ADR-0191): the switch at the foot of the model menu in Settings' New threads start with row,
 * with the same first-use question as a thread's own. A new thread takes it only on a provider that can oversee, so the
 * choice stays saved while another provider's model is the default, and `blocked` says so.
 */
export function useNewThreadsDynamicSwitch({ state, provider, modelName }: {
  readonly state: AgentState; readonly provider: ProviderId | undefined; readonly modelName: string
}): { readonly overseeing: boolean; readonly blocked: boolean; readonly suffix: string | undefined; readonly foot: ((close: () => void) => ReactNode) | undefined; readonly dialog: ReactNode } {
  const { t } = useLingui()
  const enabled = useOwlFeature('dynamic-threads')
  const app = useOptionalApp()
  const [asking, setAsking] = useState(false)
  const list = app?.settings?.dynamicThreads
  const offered = enabled && provider !== undefined && DYNAMIC_OVERSEERS.has(provider)
  const chosen = enabled && list?.newThreads === true
  const overseeing = chosen && offered
  const save = (patch: Partial<DynamicThreadSettings>): Promise<boolean> | undefined => app?.actions.updateSettings({ dynamicThreads: { ...list ?? DEFAULT_DYNAMIC_THREADS, ...patch } })
  const providers = [...new Set([...provider ? [provider] : [], ...firstAllowedProviders(state)])]
  return { overseeing, blocked: chosen && !offered,
    suffix: overseeing ? t({ message: 'oversees', comment: 'After a model\'s name on a Dynamic thread\'s chip: Opus 5.5 oversees.' }) : undefined,
    foot: !offered ? undefined : close => <Toggle label={t`Dynamic`} description={t`${modelName} oversees each new thread and chooses a model for each piece. It does no work itself.`} checked={overseeing}
      onCheckedChange={next => {
        if (next && list?.providers === undefined) { close(); setAsking(true); return }
        void save({ newThreads: next })
      }} />,
    dialog: asking ? <FirstUseQuestion title={t`Start new threads as Dynamic?`} modelName={modelName} providers={providers} onDismiss={() => setAsking(false)}
      turnOn={async () => await save({ providers, newThreads: true }) !== false} /> : null }
}

/**
 * Dynamic for one thread (ADR-0191): the switch at the foot of its model menu, and the words after the model's name on the
 * chip. The first time it is turned on, a question names the companies the allowed list would send work to, and the answer
 * makes that list, so a provider connected later never joins it. A list the user made in Settings has named them already.
 * Nothing here exists where the Owl feature is off, on a
 * provider that cannot oversee yet, on a thread on another machine or on one another thread started.
 */
export function useDynamicSwitch({ thread, state, command, modelName, fixed }: {
  readonly thread: AgentThread; readonly state: AgentState; readonly command: AgentConnection['command']; readonly modelName: string
  /** A turn runs or a request waits: it changes only at rest. */
  readonly fixed: boolean
}): { readonly overseeing: boolean; readonly suffix: string | undefined; readonly foot: ((close: () => void) => ReactNode) | undefined; readonly dialog: ReactNode } {
  const { t } = useLingui()
  const enabled = useOwlFeature('dynamic-threads')
  const app = useOptionalApp()
  const [asking, setAsking] = useState(false)
  const overseeing = isDynamicThread(thread, enabled)
  const set = (dynamic: boolean): void => { void command({ type: 'set-thread-dynamic', threadId: thread.id, dynamic }) }
  const list = app?.settings?.dynamicThreads
  const offered = enabled && whyNotDynamic(thread) === undefined
  // The thread's own provider has its code already, whether or not it is ready just now.
  const providers = [...new Set([...thread.providerId ? [thread.providerId] : [], ...firstAllowedProviders(state)])]
  const makeList = (): Promise<boolean> | undefined => app?.actions.updateSettings({ dynamicThreads: { ...list ?? DEFAULT_DYNAMIC_THREADS, providers } })
  const began = thread.nativeSessionStarted !== false
  const description = fixed ? t`It can change once this turn finishes.`
    : began && !overseeing ? t`${modelName} oversees and chooses a model for each piece, from your next message on. It does no work itself.`
    : began ? t`${modelName} oversees and chooses a model for each piece. Turned off, it works as usual from your next message on.`
    : t`${modelName} oversees and chooses a model for each piece. It does no work itself.`
  return { overseeing, suffix: overseeing ? t({ message: 'oversees', comment: 'After a model\'s name on a Dynamic thread\'s chip: Opus 5.5 oversees.' }) : undefined,
    foot: !offered ? undefined : close => <Toggle label={t`Dynamic`} description={description} checked={overseeing} disabled={fixed}
      onCheckedChange={next => {
        if (next && list?.providers === undefined) { close(); setAsking(true); return }
        set(next)
      }} />,
    dialog: asking ? <FirstUseQuestion title={t`Turn on Dynamic for this thread?`} modelName={modelName} providers={providers} onDismiss={() => setAsking(false)}
      turnOn={async () => {
        if (await makeList() === false) return false
        set(true)
        return true
      }} /> : null }
}
