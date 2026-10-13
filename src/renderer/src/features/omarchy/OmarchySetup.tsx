import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, Keyboard, LoaderCircle, Palette } from 'lucide-react'
import { OMARCHY_PIECES, type OmarchyPiece, type OmarchySetupBridge, type OmarchySetupCommand, type OmarchySetupState } from '../../../../shared/omarchySetup'
import { Button } from '../../components/Button'
import { ConfirmationDialog } from '../../components/ConfirmationDialog'
import { SottoGlyph } from '../../components/SottoMark'
import './omarchySetup.css'

const PIECES = {
  keys: { title: 'F9 and Super+Ctrl+X', short: 'the keys', what: 'Hold F9 to talk, or press Super+Ctrl+X to start and stop.',
    files: ['~/.config/hypr/sotto-bindings.lua', 'One line at the end of ~/.config/hypr/bindings.lua, after a backup copy.'] },
  owl: { title: 'The owl in the bar', short: 'the owl', what: 'Sotto in the Omarchy bar, and a pill with Stop and Cancel while you talk.',
    files: ['~/.config/omarchy/plugins/sotto.dictation/', 'Its place on the bar, in ~/.config/omarchy/shell.json.'] },
  theme: { title: 'The Omarchy theme', short: 'the theme', what: 'Sotto’s colours change with omarchy theme set.',
    files: ['~/.config/omarchy/themed/sotto.json.tpl', 'Omarchy in both columns of Settings › Appearance, with Match Linux.'] },
} as const

export function useOmarchySetup(enabled: boolean, bridge = typeof window === 'undefined' ? undefined : window.sotto?.omarchySetup) {
  const [state, setState] = useState<OmarchySetupState | null>(null)
  const [error, setError] = useState(false)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  useEffect(() => {
    if (!enabled || !bridge) return
    let active = true, changes = 0
    const unsubscribe = bridge.onChanged(next => { changes++; if (active) { setState(next); setError(false) } })
    void bridge.get().then(next => { if (active && !changes) setState(next) }).catch(() => { if (active) setError(true) })
    return () => { active = false; unsubscribe() }
  }, [bridge, enabled])
  const command = async (command: OmarchySetupCommand): Promise<void> => {
    if (!bridge || pendingRef.current) return
    pendingRef.current = true; setPending(true); setError(false)
    try { setState(await bridge.command(command)) }
    catch { setError(true) }
    finally { pendingRef.current = false; setPending(false) }
  }
  const retryRead = async (): Promise<void> => {
    if (!bridge) return
    setError(false)
    try { setState(await bridge.get()) } catch { setError(true) }
  }
  return { state, error, busy: pending || state?.busy === true, available: !!bridge, command, retryRead }
}
export type OmarchySetupController = ReturnType<typeof useOmarchySetup>

export function OmarchySetupPanel({ surface = 'settings', controller, bridge }: {
  readonly surface?: 'settings' | 'first-run'
  readonly controller?: OmarchySetupController
  readonly bridge?: OmarchySetupBridge
}): ReactNode {
  const local = useOmarchySetup(!controller, bridge ?? window.sotto?.omarchySetup)
  const setup = controller ?? local
  const { state, busy } = setup
  const [keyChoice, setKeyChoice] = useState<'give' | 'keep'>('give')
  const [files, setFiles] = useState(false)
  const [updateQuestion, setUpdateQuestion] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const filesButton = useRef<HTMLButtonElement>(null)
  const label = useId()
  const all = state && OMARCHY_PIECES.every(piece => ['done', 'manual'].includes(state.pieces[piece].status))
  const todo = state ? OMARCHY_PIECES.filter(piece => state.pieces[piece].status === 'missing' ||
    (piece === 'keys' && (state.pieces.keys.status === 'conflict' && !state.pieces.keys.owned && state.keyConflicts.length > 0 ||
      state.pieces.keys.status === 'stale' && state.keyConflicts.length > 0 || state.pieces.keys.status === 'skipped' && keyChoice === 'give'))) : []
  const owned = state ? OMARCHY_PIECES.filter(piece => state.pieces[piece].owned && ['done', 'stale', 'missing', 'failed', 'skipped'].includes(state.pieces[piece].status)) : []
  const act = async (command: OmarchySetupCommand): Promise<void> => {
    const focused = document.activeElement
    await setup.command(command)
    // A vanished Set up or Remove gives focus to the action that carries on.
    requestAnimationFrame(() => {
      if (surface === 'first-run' && root.current?.querySelector('.omarchy-setup__done')) {
        const body = root.current.closest<HTMLElement>('.onboarding-card__body')
        if (body) body.scrollTop = 0
      }
      if (focused instanceof HTMLElement && focused.isConnected && !focused.hasAttribute('disabled')) return
      const next = root.current?.querySelector<HTMLButtonElement>('button[data-next]:not(:disabled)') ??
        (surface === 'first-run' ? document.querySelector<HTMLButtonElement>('.onboarding-actions button:last-child:not(:disabled)') : root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))
      ;(next ?? root.current)?.focus()
    })
  }
  const install = (pieces: OmarchyPiece[]): Promise<void> => act({ type: 'setup', pieces, keys: state?.keyConflicts.length ? keyChoice : 'unconfirmed' })
  const statusText = (piece: OmarchyPiece): string => {
    const current = state?.pieces[piece]
    if (!current) return 'Checking'
    return { missing: 'Not set up', failed: 'Not set up', done: 'Done', manual: 'Set up by hand', stale: 'Update ready',
      conflict: 'Needs your choice', skipped: 'Left alone', queued: 'Waiting', working: current.message === 'Removing' ? 'Removing' : 'Setting up' }[current.status]
  }

  return <div className="omarchy-setup" ref={root} tabIndex={-1} aria-label="Omarchy setup" aria-busy={busy}
    onKeyDown={event => { if (event.key === 'Escape' && files && !updateQuestion) { event.stopPropagation(); setFiles(false); filesButton.current?.focus() } }}>
    {surface === 'settings' ? <div className="omarchy-setup__head"><div>
      <p className="tt-field__label">Omarchy</p><p className="tt-field__description">Sotto’s keys, its owl in the bar and the Omarchy theme.</p>
    </div>{owned.length > 0 ? <Button variant="ghost" disabled={busy} onClick={() => void act({ type: 'remove', pieces: owned })}>Remove all</Button> : null}</div> : null}
    {state?.notice ? <p className="omarchy-setup__notice" role="status">{state.notice}</p> : null}
    {setup.error || !setup.available ? <p role="alert">Sotto could not check Omarchy setup. Your files were left alone. Try again.
      {setup.available ? <Button variant="secondary" onClick={() => void setup.retryRead()}>Try again</Button> : null}</p> : null}
    <ul className="omarchy-setup__pieces">
      {OMARCHY_PIECES.map(piece => {
        const current = state?.pieces[piece], definition = PIECES[piece]
        const conflict = piece === 'keys' && state && state.keyConflicts.length > 0 &&
          (['missing', 'stale', 'skipped'].includes(current?.status ?? '') || current?.status === 'conflict' && !current.owned)
        return <li key={piece} className="omarchy-setup__piece" data-piece={piece} data-state={current?.status ?? 'checking'}>
          <span className="omarchy-setup__icon">{piece === 'keys' ? <Keyboard size={20} /> : piece === 'theme' ? <Palette size={20} /> : <SottoGlyph />}</span>
          <strong className="omarchy-setup__name">{definition.title}</strong>
          <p className="omarchy-setup__what">{definition.what}</p>
          <div className="omarchy-setup__side"><span className="omarchy-setup__status" role="status">
            {current?.status === 'working' ? <LoaderCircle size={15} className="omarchy-setup__spin" aria-hidden="true" /> : ['done', 'manual'].includes(current?.status ?? '') ? <Check size={15} aria-hidden="true" /> : null}
            {statusText(piece)}</span>
            {surface === 'settings' && owned.includes(piece) ? <Button variant="ghost" disabled={busy} aria-label={`Remove ${definition.short}`} onClick={() => void act({ type: 'remove', pieces: [piece] })}>Remove</Button> : null}
            {current?.status === 'stale' && piece === 'owl' ? <Button variant="secondary" disabled={busy} onClick={() => setUpdateQuestion(true)}>Update the owl</Button> : null}
          </div>
          {conflict ? <div className="omarchy-setup__detail"><p id={`${label}-keys`}>{state.keyConflicts.join(' ')}</p>
            <div className="omarchy-setup__choices" role="radiogroup" aria-labelledby={`${label}-keys`}>
              <label><input type="radio" name={`${label}-choice`} checked={keyChoice === 'give'} disabled={busy} onChange={() => setKeyChoice('give')} />Give F9 to Sotto</label>
              <label><input type="radio" name={`${label}-choice`} checked={keyChoice === 'keep'} disabled={busy} onChange={() => setKeyChoice('keep')} />Leave my keys alone</label>
            </div>
          </div> : null}
          {piece === 'keys' && state?.voxtype && current?.status === 'missing' ? <p className="omarchy-setup__detail">Voxtype has these keys now. Sotto takes them over; Voxtype stays installed.</p> : null}
          {current?.message && current.status !== 'working' ? <div className="omarchy-setup__detail" role={current.status === 'failed' ? 'alert' : undefined}><p>{current.message}</p>
            {current.status === 'failed' ? <Button data-next variant="secondary" disabled={busy} aria-label={`Try ${definition.short} again`} onClick={() => void install([piece])}>Try again</Button> : null}
          </div> : null}
          {files ? <ul className="omarchy-setup__files">{definition.files.map(file => <li key={file}>{file}</li>)}</ul> : null}
        </li>
      })}
    </ul>
    {all ? <div className="omarchy-setup__done" role="status"><strong>Sotto is set up in Omarchy.</strong>
      <p>{surface === 'first-run' ? 'You’ll try F9 in the Shortcut step, once the speech model is downloaded.' : 'Hold F9 anywhere to talk.'}</p></div> : null}
    <div className="omarchy-setup__actions">
      {todo.length > 0 || busy ? <Button data-next disabled={busy} onClick={() => void install(todo)}>
        {busy ? 'Setting up' : todo.length === 3 ? 'Set up all three' : `Set up ${todo.map(piece => PIECES[piece].short).join(' and ')}`}
      </Button> : null}
      <Button ref={filesButton} variant="ghost" aria-expanded={files} onClick={() => setFiles(!files)}>{files ? 'Hide the files it changes' : 'Show the files it changes'}</Button>
    </div>
    {updateQuestion ? <ConfirmationDialog title="Update the owl?" description="Updating restarts the bar for a moment."
      confirmLabel="Update the owl" cancelLabel="Cancel" danger={false}
      onConfirm={async () => { await act({ type: 'update-owl' }) }} onCancel={() => setUpdateQuestion(false)} fallbackFocusRef={root} /> : null}
  </div>
}
