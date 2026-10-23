import React, { type ReactNode } from 'react'
import { Laptop, Server } from 'lucide-react'
import { t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { parseHostEntityKey } from '../../../shared/clientIdentity'
import type { AgentState } from '../../../shared/agents'
import './hostBadge.css'

/** A host threads can be listed from: a connected remote host, or this computer. */
export interface ListedHost { readonly hostId: string; readonly name: string; readonly kind: 'local' | 'remote' }

/** What a host is called where work happens: "This computer" for the local host, the saved name for a remote one. */
export const listedHostName = (host: Pick<ListedHost, 'name' | 'kind'>): string => host.kind === 'local' ? t({ message: 'This computer', comment: 'The computer Sotto runs on, named among the hosts that run threads.' }) : host.name

/**
 * The hosts whose threads the Threads page can list, once a remote host is connected (the owner's rule for
 * #206). Empty while this computer is the only host: the host is then shown nowhere, as T3 Code does. A remote
 * host alone, with the local host off, is still named, since then every thread runs somewhere else.
 */
export function listedHosts(state: Pick<AgentState, 'connections'>): readonly ListedHost[] {
  const connections = state.connections ?? []
  return connections.some(item => item.kind === 'remote') ? connections.map(item => ({ hostId: item.hostId, name: listedHostName(item), kind: item.kind })) : []
}

/** Where a thread runs, named as the host list names it, so a remote host alone is still called by its name. */
export function threadHostName(state: Pick<AgentState, 'connections'>, thread: { readonly hostId?: string | undefined; readonly remoteHost?: boolean | undefined; readonly hostLabel?: string | undefined }): string {
  return listedHosts(state).find(item => item.hostId === thread.hostId)?.name ?? (thread.remoteHost ? thread.hostLabel ?? t`Remote host` : t({ message: 'This computer', comment: 'The computer Sotto runs on, named among the hosts that run threads.' }))
}

/** The host a project or thread lives on, from its client-scoped ID when it carries no host ID of its own. */
export const hostIdOf = (entity: { readonly id: string; readonly hostId?: string | undefined } | undefined): string | undefined =>
  entity === undefined ? undefined : entity.hostId ?? parseHostEntityKey(entity.id)?.hostId

/** A small label naming the host a project is on. Decorative: the row it sits in carries the host in its name. */
export function HostBadge({ host }: { readonly host: ListedHost }): ReactNode {
  const { t } = useLingui()
  const Icon = host.kind === 'local' ? Laptop : Server
  const hostName = host.name
  return <span className="host-badge" data-kind={host.kind} title={t({ message: `On ${hostName}`, comment: 'The tooltip on a badge naming the host a project is on.' })} aria-hidden="true"><Icon size={11} /><span className="host-badge__name">{host.name}</span></span>
}
