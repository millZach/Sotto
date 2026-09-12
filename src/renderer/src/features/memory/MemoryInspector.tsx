import React, { useState, type ReactNode } from 'react'
import { MAX_MEMORY_CONTENT_CHARACTERS, memoryTopicSchema, type MemoryItem } from '../../../../shared/memory'
import { Button } from '../../components/Button'
import { boundaryLabels } from './questions'
import type { MemoryController } from './useMemory'

function date(value: string | null): string { return value === null ? 'Not recorded' : new Date(value).toLocaleString() }

interface MemoryEditor { memory: MemoryItem; type: 'edit' | 'supersede'; text: string }

function MemoryRow({ memory, controller, editor, onEditorChange, replacement, missing, anotherEditor }: {
  memory: MemoryItem; controller: MemoryController; editor: MemoryEditor | null
  onEditorChange: (editor: MemoryEditor | null) => void; replacement: MemoryItem | undefined; missing: boolean; anotherEditor: boolean
}): ReactNode {
  const [deleting, setDeleting] = useState(false)
  const historical = memory.supersededBy !== null || memory.state === 'superseded'
  const stale = historical || missing
  const topic = memory.tags.find(tag => memoryTopicSchema.safeParse(tag).success)
  const save = async () => {
    if (editor && !stale && await controller.command({ type: editor.type, id: memory.id, content: editor.text })) onEditorChange(null)
  }
  return <article className="memory-item" aria-label={memory.content}>
    <p className="memory-content">{memory.content}</p>
    {editor && <>
      {stale && <p className="memory-description">{missing
        ? 'This memory was deleted. Your unsaved wording is still here to copy.'
        : 'This memory changed in another window. Your unsaved wording is still here. Review its current replacement before saving.'}</p>}
      <textarea className="memory-answer" aria-label={editor.type === 'edit' ? 'Edit memory' : 'Replacement memory'} value={editor.text} maxLength={MAX_MEMORY_CONTENT_CHARACTERS} rows={4}
        onChange={event => onEditorChange({ ...editor, text: event.target.value })} disabled={controller.busy} autoFocus />
      <div className="memory-actions">
        {stale && replacement ? <Button disabled={controller.busy} onClick={() => onEditorChange({ ...editor, memory: replacement })}>Review current replacement</Button>
          : <Button disabled={controller.busy || stale || !editor.text.trim()} onClick={() => void save()}>{controller.busy ? 'Saving…' : 'Save memory'}</Button>}
        <Button variant="ghost" disabled={controller.busy} onClick={() => onEditorChange(null)}>Cancel</Button>
      </div>
    </>}
    <p className="memory-meta">{topic ? `${topic} · ` : ''}{memory.sourceClass === 'explicit' ? 'You told Sotto' : memory.sourceClass} · {date(memory.createdAt)}{memory.scope === 'global' ? '' : ` · Project: ${memory.scope}`}{historical ? ' · Superseded' : memory.state === 'active' ? '' : ` · ${memory.state}`}</p>
    <details className="memory-details">
      <summary>Why Sotto remembers this</summary>
      <dl>
        <dt>Source</dt><dd>{memory.sourceClass}</dd>
        <dt>Confidence</dt><dd>{Math.round(memory.confidence * 100)}%</dd>
        <dt>Evidence</dt><dd>{memory.evidenceCount}</dd>
        <dt>Scope</dt><dd>{memory.scope}</dd>
        <dt>Type</dt><dd>{memory.type}</dd>
        <dt>Authority</dt><dd>{memory.authority} (memory does not grant permission)</dd>
        <dt>Importance</dt><dd>{memory.importance}</dd>
        <dt>Last confirmed</dt><dd>{date(memory.lastConfirmedAt)}</dd>
        <dt>Last used</dt><dd>{date(memory.lastUsedAt)}</dd>
        <dt>Valid from</dt><dd>{date(memory.validFrom)}</dd>
        <dt>Valid until</dt><dd>{memory.validTo === null ? 'No end date' : date(memory.validTo)}</dd>
        <dt>State</dt><dd>{memory.state}</dd>
        <dt>Tags</dt><dd>{memory.tags.join(', ') || 'None'}</dd>
        <dt>Memory ID</dt><dd>{memory.id}</dd>
        {memory.supersededBy && <><dt>Replaced by</dt><dd>{memory.supersededBy}</dd></>}
      </dl>
      <ul>{memory.provenance.map((source, index) => <li key={index}>
        {'threadId' in source ? `Thread ${source.threadId}: ${source.ref}` : `${source.source === 'questionnaire' ? 'Working preferences' : 'Memory inspector'} · ${date(source.recordedAt)} · ${source.ref}`}
      </li>)}</ul>
    </details>
    {!editor && !deleting && <div className="memory-actions">
      {!historical && <><Button variant="ghost" disabled={controller.busy || anotherEditor} onClick={() => onEditorChange({ memory, type: 'edit', text: memory.content })}>Edit</Button>
        <Button variant="ghost" disabled={controller.busy || anotherEditor} onClick={() => onEditorChange({ memory, type: 'supersede', text: '' })}>Supersede</Button></>}
      <Button variant="ghost" disabled={controller.busy || anotherEditor} onClick={() => setDeleting(true)}>Delete</Button>
    </div>}
    {deleting && <div className="memory-delete">
      <p>Delete this memory and all its past versions? This cannot be undone.</p>
      <div className="memory-actions"><Button variant="danger" disabled={controller.busy} onClick={() => void controller.command({ type: 'delete', id: memory.id })}>Delete memory</Button>
        <Button variant="ghost" disabled={controller.busy} onClick={() => setDeleting(false)}>Cancel</Button></div>
    </div>}
  </article>
}

export function MemoryInspector({ controller, onQuestionnaire }: { controller: MemoryController; onQuestionnaire: () => void }): ReactNode {
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
  return <section className="memory-page" aria-label="Memory inspector">
    <h1>What Sotto remembers</h1>
    <p className="memory-description">Preferences stay on this computer. Relevant preferences go to your selected reasoning provider with a request.</p>
    {error && <div role="alert" className="memory-error">{error} <Button variant="ghost" onClick={() => void controller.refresh()}>Refresh memory</Button></div>}
    {!snapshot ? <p role="status">{error ? 'Memory has not loaded.' : 'Reading memory…'}</p> : !snapshot.available ? <p role="status">Memory is unavailable. Restart Sotto and try again.</p> : <>
      <div className="memory-toolbar">
        {!snapshot.questionnaireCompletedAt && <Button onClick={onQuestionnaire}>Set working preferences</Button>}
        <label className="memory-history-toggle"><input type="checkbox" checked={history} onChange={event => setHistory(event.target.checked)} />Show past versions</label>
      </div>
      {memories.length ? <div>{memories.map(memory => <MemoryRow key={memory.id} memory={memory} controller={controller}
        editor={editor?.memory.id === memory.id ? editor : null} onEditorChange={setEditor} replacement={replacement}
        missing={missingEditor && editor?.memory.id === memory.id} anotherEditor={editor !== null && editor.memory.id !== memory.id} />)}</div> : <p className="memory-empty">{snapshot.memories.length ? 'No current memories. Past versions are still available.' : 'Sotto has no saved memories yet.'}</p>}
      <section className="memory-policies" aria-label="Policies">
        <h2>Permission boundaries</h2>
        <p className="memory-description">Policies are separate from memory. Editing a preference does not change a permission.</p>
        {snapshot.policies.length ? <ul>{snapshot.policies.map(policy => <li key={policy.id}>
          <p>{policy.effect === 'always-confirm' ? 'Always confirm' : 'Allowed'}: {boundaryLabels[policy.action].toLowerCase()}</p>
          <p className="memory-meta">{policy.source === 'questionnaire' ? 'You chose this in working preferences' : 'You set this policy'} · {date(policy.grantedAt)}{policy.revokedAt ? ' · Revoked' : policy.expiresAt && new Date(policy.expiresAt).getTime() <= Date.now() ? ' · Expired' : ''}</p>
          <details className="memory-details"><summary>Policy details</summary><dl>
            <dt>Resource</dt><dd>{policy.resource}</dd><dt>Scope</dt><dd>{policy.scope}</dd>
            <dt>Expires</dt><dd>{policy.expiresAt ? date(policy.expiresAt) : 'No end date'}</dd>
            <dt>Revoked</dt><dd>{date(policy.revokedAt)}</dd><dt>Reason</dt><dd>{policy.note}</dd>
          </dl></details>
        </li>)}</ul> : <p>No saved policies. Existing permission checks still apply.</p>}
      </section>
    </>}
  </section>
}
