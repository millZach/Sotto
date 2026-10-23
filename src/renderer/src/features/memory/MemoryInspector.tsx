import React, { useState, type ReactNode } from 'react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { MAX_MEMORY_CONTENT_CHARACTERS, memoryTopicSchema, type MemoryItem } from '../../../../shared/memory'
import { Button } from '../../components/Button'
import { policyActionLabels } from './questions'
import type { MemoryController } from './useMemory'

function date(value: string | null): string { return value === null ? i18n._(msg`Not recorded`) : new Date(value).toLocaleString() }

interface MemoryEditor { memory: MemoryItem; type: 'edit' | 'supersede'; text: string }

function MemoryRow({ memory, controller, editor, onEditorChange, replacement, missing, anotherEditor }: {
  memory: MemoryItem; controller: MemoryController; editor: MemoryEditor | null
  onEditorChange: (editor: MemoryEditor | null) => void; replacement: MemoryItem | undefined; missing: boolean; anotherEditor: boolean
}): ReactNode {
  const { t } = useLingui()
  const [deleting, setDeleting] = useState(false)
  const historical = memory.supersededBy !== null || memory.state === 'superseded'
  const stale = historical || missing
  const scope = memory.scope
  const authority = memory.authority
  const topic = memory.tags.find(tag => memoryTopicSchema.safeParse(tag).success)
  const save = async () => {
    if (editor && !stale && await controller.command({ type: editor.type, id: memory.id, content: editor.text })) onEditorChange(null)
  }
  return <article className="memory-item" aria-label={memory.content}>
    <p className="memory-content">{memory.content}</p>
    {editor && <>
      {stale && <p className="memory-description">{missing
        ? t`This memory was deleted. Your unsaved wording is still here to copy.`
        : t`This memory changed in another window. Your unsaved wording is still here. Review its current replacement before saving.`}</p>}
      <textarea className="memory-answer" aria-label={editor.type === 'edit' ? t`Edit memory` : t`Replacement memory`} value={editor.text} maxLength={MAX_MEMORY_CONTENT_CHARACTERS} rows={4}
        onChange={event => onEditorChange({ ...editor, text: event.target.value })} disabled={controller.busy} autoFocus />
      <div className="memory-actions">
        {stale && replacement ? <Button disabled={controller.busy} onClick={() => onEditorChange({ ...editor, memory: replacement })}><Trans>Review current replacement</Trans></Button>
          : <Button disabled={controller.busy || stale || !editor.text.trim()} onClick={() => void save()}>{controller.busy ? t`Saving…` : t`Save memory`}</Button>}
        <Button variant="ghost" disabled={controller.busy} onClick={() => onEditorChange(null)}><Trans>Cancel</Trans></Button>
      </div>
    </>}
    <p className="memory-meta">{topic ? `${topic} · ` : ''}{memory.sourceClass === 'explicit' ? t`You told Sotto` : memory.sourceClass} · {date(memory.createdAt)}{memory.scope === 'global' ? '' : ` · ${t`Project: ${scope}`}`}{historical ? ` · ${t`Superseded`}` : memory.state === 'active' ? '' : ` · ${memory.state}`}</p>
    <details className="memory-details">
      <summary><Trans>Why Sotto remembers this</Trans></summary>
      <dl>
        <dt><Trans>Source</Trans></dt><dd>{memory.sourceClass}</dd>
        <dt><Trans>Confidence</Trans></dt><dd>{Math.round(memory.confidence * 100)}%</dd>
        <dt><Trans>Evidence</Trans></dt><dd>{memory.evidenceCount}</dd>
        <dt><Trans>Scope</Trans></dt><dd>{memory.scope}</dd>
        <dt><Trans>Type</Trans></dt><dd>{memory.type}</dd>
        <dt><Trans>Authority</Trans></dt><dd><Trans>{authority} (memory does not grant permission)</Trans></dd>
        <dt><Trans>Importance</Trans></dt><dd>{memory.importance}</dd>
        <dt><Trans>Last confirmed</Trans></dt><dd>{date(memory.lastConfirmedAt)}</dd>
        <dt><Trans>Last used</Trans></dt><dd>{date(memory.lastUsedAt)}</dd>
        <dt><Trans>Valid from</Trans></dt><dd>{date(memory.validFrom)}</dd>
        <dt><Trans>Valid until</Trans></dt><dd>{memory.validTo === null ? t`No end date` : date(memory.validTo)}</dd>
        <dt><Trans>State</Trans></dt><dd>{memory.state}</dd>
        <dt><Trans>Tags</Trans></dt><dd>{memory.tags.join(', ') || t`None`}</dd>
        <dt><Trans>Memory ID</Trans></dt><dd>{memory.id}</dd>
        {memory.supersededBy && <><dt><Trans>Replaced by</Trans></dt><dd>{memory.supersededBy}</dd></>}
      </dl>
      <ul>{memory.provenance.map((source, index) => <li key={index}>
        {'threadId' in source ? provenanceOfThread(source.threadId, source.ref) : `${source.source === 'questionnaire' ? t`Working preferences` : t`Memory inspector`} · ${date(source.recordedAt)} · ${source.ref}`}
      </li>)}</ul>
    </details>
    {!editor && !deleting && <div className="memory-actions">
      {!historical && <><Button variant="ghost" disabled={controller.busy || anotherEditor} onClick={() => onEditorChange({ memory, type: 'edit', text: memory.content })}><Trans>Edit</Trans></Button>
        <Button variant="ghost" disabled={controller.busy || anotherEditor} onClick={() => onEditorChange({ memory, type: 'supersede', text: '' })}><Trans>Supersede</Trans></Button></>}
      <Button variant="ghost" disabled={controller.busy || anotherEditor} onClick={() => setDeleting(true)}><Trans>Delete</Trans></Button>
    </div>}
    {deleting && <div className="memory-delete">
      <p><Trans>Delete this memory and all its past versions? This cannot be undone.</Trans></p>
      <div className="memory-actions"><Button variant="danger" disabled={controller.busy} onClick={() => void controller.command({ type: 'delete', id: memory.id })}><Trans>Delete memory</Trans></Button>
        <Button variant="ghost" disabled={controller.busy} onClick={() => setDeleting(false)}><Trans>Cancel</Trans></Button></div>
    </div>}
  </article>
}

/** Where a memory came from, when a thread said it. */
function provenanceOfThread(threadId: string, ref: string): string {
  return i18n._(msg`Thread ${threadId}: ${ref}`)
}

export function MemoryInspector({ controller, onQuestionnaire }: { controller: MemoryController; onQuestionnaire: () => void }): ReactNode {
  const { t } = useLingui()
  const [history, setHistory] = useState(false)
  const [editor, setEditor] = useState<MemoryEditor | null>(null)
  const { snapshot, error } = controller
  const missingEditor = editor !== null && !snapshot?.memories.some(memory => memory.id === editor.memory.id)
  const memories = snapshot?.memories.filter(memory => history || memory.id === editor?.memory.id || (memory.state !== 'superseded' && memory.supersededBy === null)) ?? []
  if (editor && missingEditor) memories.unshift(editor.memory)
  let replacement = editor ? snapshot?.memories.find(memory => memory.id === editor.memory.id) : undefined
  const visited = new Set<string>()
  while (replacement?.supersededBy && !visited.has(replacement.id)) {
    visited.add(replacement.id)
    replacement = snapshot?.memories.find(memory => memory.id === replacement?.supersededBy)
  }
  if (replacement?.id === editor?.memory.id || replacement?.supersededBy || replacement?.state === 'superseded') replacement = undefined
  return <section className="memory-page" aria-label={t`Memory inspector`}>
    <h1><Trans>What Sotto remembers</Trans></h1>
    <p className="memory-description"><Trans>Preferences stay on this computer. Sotto does not send them to any provider.</Trans></p>
    {error && <div role="alert" className="memory-error">{error} <Button variant="ghost" onClick={() => void controller.refresh()}><Trans>Refresh memory</Trans></Button></div>}
    {!snapshot ? <p role="status">{error ? t`Memory has not loaded.` : t`Reading memory…`}</p> : !snapshot.available ? <p role="status"><Trans>Memory is unavailable. Restart Sotto and try again.</Trans></p> : <>
      <div className="memory-toolbar">
        {!snapshot.questionnaireCompletedAt && <Button onClick={onQuestionnaire}><Trans>Set working preferences</Trans></Button>}
        <label className="memory-history-toggle"><input type="checkbox" checked={history} onChange={event => setHistory(event.target.checked)} /><Trans>Show past versions</Trans></label>
      </div>
      {memories.length ? <div>{memories.map(memory => <MemoryRow key={memory.id} memory={memory} controller={controller}
        editor={editor?.memory.id === memory.id ? editor : null} onEditorChange={setEditor} replacement={replacement}
        missing={missingEditor && editor?.memory.id === memory.id} anotherEditor={editor !== null && editor.memory.id !== memory.id} />)}</div> : <p className="memory-empty">{snapshot.memories.length ? t`No current memories. Past versions are still available.` : t`Sotto has no saved memories yet.`}</p>}
      <section className="memory-policies" aria-label={t`Policies`}>
        <h2><Trans>Permission boundaries</Trans></h2>
        <p className="memory-description"><Trans>Policies are separate from memory. Editing a preference does not change a permission.</Trans></p>
        {snapshot.policies.length ? <ul>{snapshot.policies.map(policy => {
          const action = policyActionLabels[policy.action].toLowerCase()
          return <li key={policy.id}>
            <p>{policy.effect === 'always-confirm' ? t`Always confirm: ${action}` : t`Allowed: ${action}`}</p>
            <p className="memory-meta">{policy.source === 'questionnaire' ? t`You chose this in working preferences` : t`You set this policy`} · {date(policy.grantedAt)}{policy.revokedAt ? ` · ${t`Revoked`}` : policy.expiresAt && new Date(policy.expiresAt).getTime() <= Date.now() ? ` · ${t`Expired`}` : ''}</p>
            <details className="memory-details"><summary><Trans>Policy details</Trans></summary><dl>
              <dt><Trans>Resource</Trans></dt><dd>{policy.resource}</dd><dt><Trans>Scope</Trans></dt><dd>{policy.scope}</dd>
              <dt><Trans>Expires</Trans></dt><dd>{policy.expiresAt ? date(policy.expiresAt) : t`No end date`}</dd>
              <dt><Trans>Revoked</Trans></dt><dd>{date(policy.revokedAt)}</dd><dt><Trans>Reason</Trans></dt><dd>{policy.note}</dd>
            </dl></details>
          </li>
        })}</ul> : <p><Trans>No saved policies. Existing permission checks still apply.</Trans></p>}
      </section>
    </>}
  </section>
}
