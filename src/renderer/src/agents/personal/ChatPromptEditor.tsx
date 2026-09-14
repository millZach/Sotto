import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PersonalChat } from '../../../../shared/personalChats'
import { Button } from '../../components/Button'
import './chatPromptEditor.css'

interface PromptDraft { text: string; pending: boolean; error: string | null; source: string }

export function ChatPromptEditor({ chat }: { readonly chat: PersonalChat }): ReactNode {
  const bridge = window.sotto?.chatPrompts
  const [drafts, setDrafts] = useState<Record<string, PromptDraft>>({})
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const busy = useRef(new Set<string>())
  const draft = drafts[chat.id]
  const source = JSON.stringify(chat.messages.filter(message => message.role === 'user' || message.role === 'assistant').map(({ id, role, text }) => ({ id, role, text })))
  const stale = Boolean(draft?.source && draft.source !== source)
  const blocked = chat.status === 'running' || Boolean(chat.requests.length) || chat.historyStatus === 'loading' || chat.historyStatus === 'error'
    || chat.nativeState === 'starting' || chat.nativeState === 'uncertain'
    || chat.submissions.some(item => item.status === 'submitting' || item.status === 'uncertain') || !chat.messages.some(message => message.role === 'user' && message.text.trim())

  useEffect(() => { setOpen(false); setCopied(false); setCopyError(false) }, [chat.id])
  useEffect(() => {
    const node = dialog.current
    if (open) { node?.showModal(); editor.current?.focus() }
    else if (node?.open) { node.close(); opener.current?.focus() }
  }, [open])
  useEffect(() => { if (open && !draft?.pending) editor.current?.focus() }, [draft?.pending, open])

  const generate = async (): Promise<void> => {
    const id = chat.id
    if (!bridge || busy.current.has(id)) return
    busy.current.add(id)
    setCopied(false); setCopyError(false)
    setDrafts(current => ({ ...current, [id]: { text: current[id]?.text ?? '', source: current[id]?.source ?? '', pending: true, error: null } }))
    try {
      const result = await bridge.generate({ chatId: id })
      if (result.chatId !== id) throw new Error('The prompt did not belong to this chat. Try again.')
      setDrafts(current => ({ ...current, [id]: { text: result.text, source, pending: false, error: null } }))
    } catch (error) {
      setDrafts(current => ({ ...current, [id]: { text: current[id]?.text ?? '', source: current[id]?.source ?? '', pending: false, error: error instanceof Error ? error.message : 'Sotto could not generate this prompt. Try again.' } }))
    } finally { busy.current.delete(id) }
  }
  const show = (): void => {
    setOpen(true); setCopied(false); setCopyError(false)
    if (!draft) void generate()
  }
  const copy = async (): Promise<void> => {
    setCopied(false); setCopyError(false)
    try { await bridge!.copy(draft?.text ?? ''); setCopied(true) }
    catch { setCopyError(true); editor.current?.focus(); editor.current?.select() }
  }
  if (!bridge) return null
  return <>
    <Button ref={opener} variant="ghost" disabled={!draft?.text && blocked} onClick={show}
      title={blocked && !draft?.text ? 'Finish the chat and resolve pending work first.' : 'Turn this chat into an editable prompt'}>
      {draft?.pending ? 'Making prompt…' : draft?.text ? 'Edit prompt' : 'Make prompt'}
    </Button>
    {createPortal(<dialog ref={dialog} className="chat-prompt-editor" aria-labelledby="chat-prompt-editor-title"
      onCancel={event => { event.preventDefault(); setOpen(false) }}>
      <header><h2 id="chat-prompt-editor-title">Prompt from this chat</h2><Button variant="ghost" onClick={() => setOpen(false)}>Close</Button></header>
      <p id="chat-prompt-editor-help">{stale ? 'This discussion has changed. Regenerate to include the latest messages and replace this draft.' : 'Review the decisions and open questions before using this prompt.'}</p>
      {draft?.pending ? <div className="chat-prompt-editor__status" role="status">Making a prompt from the saved discussion…</div> : null}
      {draft?.error ? <div className="chat-prompt-editor__error" role="alert"><p>{draft.error}</p><Button variant="secondary" disabled={blocked} onClick={() => void generate()}>Try again</Button></div> : null}
      <textarea ref={editor} aria-label="Editable prompt" aria-describedby="chat-prompt-editor-help" value={draft?.text ?? ''} maxLength={64000}
        disabled={draft?.pending || !draft?.text && Boolean(draft?.error)} spellCheck={false}
        onChange={event => { const text = event.currentTarget.value; setCopied(false); setCopyError(false); setDrafts(current => ({ ...current, [chat.id]: { text, source: current[chat.id]?.source ?? '', pending: false, error: null } })) }} />
      <footer>{copyError ? <span role="alert">Copy failed. The text is selected; press Ctrl+C.</span> : copied ? <span role="status">Copied</span> : <span />}
        <Button variant="secondary" disabled={blocked || draft?.pending} title="Replace this draft with a new prompt from the latest discussion" onClick={() => void generate()}>Regenerate prompt</Button>
        <Button variant="primary" disabled={!draft?.text.trim() || draft.pending} onClick={() => void copy()}>Copy prompt</Button></footer>
    </dialog>, document.body)}
  </>
}
