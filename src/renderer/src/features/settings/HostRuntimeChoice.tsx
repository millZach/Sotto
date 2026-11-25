import React, { type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import type { HostRuntime, HostsCommand, HostStatus } from '../../../../shared/hosts'
import { SegmentedControl } from '../../components/SegmentedControl'
import { useOwlFeature } from '../../state/owlFeature'

/**
 * A remote host's host program (ADR-0214; the Owl feature `rust-remote-host`): Node, which every host runs unless the owner
 * picks otherwise, or the Rust `sotto-host` preview. A press saves the choice for this host and restarts a host Sotto
 * started that this computer is connected to; any other host takes it when it next starts, and the row says so.
 */
export function HostRuntimeChoice({ host, onCommand }: {
  readonly host: HostStatus
  readonly onCommand: (command: HostsCommand) => Promise<boolean>
}): ReactNode {
  const { t } = useLingui()
  const offered = useOwlFeature('rust-remote-host')
  if (!offered || host.runtime === undefined) return null
  const chosen = host.runtime, running = host.runningRuntime
  const programName = (runtime: HostRuntime): string => runtime === 'rust'
    ? t({ message: 'Rust (preview)', comment: 'The Rust host program on a remote host, still a preview.' })
    : t({ message: 'Node', comment: 'The Node host program on a remote host.' })
  const busy = host.switchingRuntime === true || host.phase === 'connecting'
  const note = host.switchingRuntime
    ? t`Restarting on ${programName(chosen)}…`
    : host.phase === 'connected' && running !== undefined && running !== chosen
      ? t`Runs ${programName(running)} now, and ${programName(chosen)} from its next start.`
      : null
  return <div className="hosts-row__runtime">
    <span className="hosts-row__runtime-label" aria-hidden="true">{t({ message: 'Host program', comment: 'Label before a remote host’s Node | Rust choice.' })}</span>
    <SegmentedControl label={t`Host program on ${host.name}`} value={chosen} disabled={busy}
      onChange={value => { if (value !== chosen) void onCommand({ type: 'set-runtime', id: host.id, runtime: value as HostRuntime }) }}
      options={[
        { value: 'node', label: t({ message: 'Node', comment: 'The Node host program on a remote host.' }) },
        { value: 'rust', label: t({ message: 'Rust', comment: 'The Rust host program on a remote host, a preview.' }) },
      ]} />
    {chosen === 'rust' ? <span className="hosts-row__runtime-tag">{t({ message: 'Preview', comment: 'The Rust host program is still a preview.' })}</span> : null}
    {note ? <span className="hosts-row__runtime-note" role="status">{note}</span> : null}
  </div>
}
