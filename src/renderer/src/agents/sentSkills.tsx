import React, { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import type { Element, ElementContent, Root, Text } from 'hast'
import { useLingui } from '@lingui/react/macro'
import { capabilitiesForThread, type AgentState } from '../../../shared/agents'
import type { AgentConnection } from './AgentContext'
import { pickableSkills, skillScopeLabel, skillSigils, type CatalogSkill } from './composerSkills'
import { SkillPill } from './SkillPill'
import type { ThreadRow } from './threadFacts'

/**
 * A token a sent message might name a skill with: a `$` or `/` word standing alone, closed where the composer closes one
 * (`MENTION_CLOSERS`). A name may hold dots but never ends on one, so a sentence's full stop stays outside it.
 */
const SKILL_TOKEN = /(?<=^|\s)[$/][A-Za-z0-9](?:[\w.:-]*[\w:-])?(?=$|[\s.,;!?()[\]{}])/gu
const MAY_NAME_SKILL = new RegExp(SKILL_TOKEN.source, 'u')

/** The thread's skills by each token that names them, while its catalog is loaded. */
export const SentSkillsContext = createContext<ReadonlyMap<string, CatalogSkill> | null>(null)

/**
 * The skills this thread's sent messages can name, for `SkillToken` to draw. The catalog loads when the picker first opens;
 * a message that may name a skill asks for it too, once, so a thread read after a restart shows its pills. It asks only while
 * the provider is connected, since a refused read stands as the catalog until the picker reloads it. Only skills the picker
 * offers are drawn.
 */
export function useSentSkills(row: ThreadRow, state: AgentState, command: AgentConnection['command']): ReadonlyMap<string, CatalogSkill> | null {
  const thread = row.thread
  const supported = capabilitiesForThread(state.host, thread).skills === true
  const catalog = supported ? state.skillCatalogs?.find(item => item.threadId === thread.id) : undefined
  // Read again when a message comes or goes, not at every streamed word.
  const asks = useMemo(() => supported && row.connected && catalog === undefined && thread.messages.some(message => message.role === 'user' && MAY_NAME_SKILL.test(message.text)),
    [supported, row.connected, catalog, thread.messages.length])
  useEffect(() => { if (asks) void command({ type: 'refresh-thread-skills', threadId: thread.id }) }, [asks, command, thread.id])
  return useMemo(() => {
    if (catalog?.status !== 'ready') return null
    const skills = new Map<string, CatalogSkill>()
    for (const skill of pickableSkills(catalog.skills)) for (const sigil of skillSigils(row.providerId)) if (!skills.has(`${sigil}${skill.name}`)) skills.set(`${sigil}${skill.name}`, skill)
    return skills
  }, [catalog, row.providerId])
}

/** Puts each token of a sent message that may name a skill in a span of its own for `SkillToken`. Code and links keep theirs. */
export function rehypeSkillTokens() {
  return (tree: Root): void => { for (const child of tree.children) if (child.type === 'element') mark(child) }
}
function mark(element: Element): void {
  if (element.tagName === 'a' || element.tagName === 'code' || element.tagName === 'pre') return
  element.children = element.children.flatMap((child): ElementContent[] => {
    if (child.type === 'element') mark(child)
    return child.type === 'text' ? split(child) : [child]
  })
}
function split(text: Text): ElementContent[] {
  const parts: ElementContent[] = []
  let at = 0
  for (const match of text.value.matchAll(SKILL_TOKEN)) {
    if (match.index > at) parts.push({ type: 'text', value: text.value.slice(at, match.index) })
    parts.push({ type: 'element', tagName: 'span', properties: { dataSkillToken: match[0] }, children: [{ type: 'text', value: match[0] }] })
    at = match.index + match[0].length
  }
  if (!parts.length) return [text]
  if (at < text.value.length) parts.push({ type: 'text', value: text.value.slice(at) })
  return parts
}

/**
 * A sent skill as the composer showed it: its pill when the thread's catalog names the token, else the token's text. The
 * pill's wrapper keeps the token, which copying the message as plain text writes in its place.
 */
export function SkillToken({ token, children }: { readonly token: string; readonly children?: ReactNode }): ReactNode {
  const { t } = useLingui()
  const skill = useContext(SentSkillsContext)?.get(token)
  return skill ? <span data-skill-token={token}><SkillPill name={skill.name} token={token} description={skill.description} scope={t(skillScopeLabel(skill.scope))} /></span>
    : <>{children}</>
}
