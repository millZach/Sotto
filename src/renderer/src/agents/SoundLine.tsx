import { t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { AudioLines, ChevronDown, FolderOutput, Music, Pause, Play, TriangleAlert, Zap } from 'lucide-react'
import React, { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react'
import { dollarFigure } from '../../../shared/plugins'
import { soundFileGone, type SoundFailure, type SoundKind, type SoundView } from '../../../shared/sounds'
import { useOwlFeature } from '../state/owlFeature'
import { useReducedMotion } from '../state/reducedMotion'
import { sizeWords } from './modelParts'
import './soundLine.css'

/**
 * A sound ElevenLabs made for a thread, in that thread (ADR-0205; the plugins plan's slice 12, part 3, Zach's pick on
 * #2498, variant A): a quiet line under the agent's turn, as a 3D model's line is, with the kind's tile, the name, and
 * the kind, length and cost. Play fetches the MP3 the first time it is pressed, into an audio element that press makes;
 * nothing plays on its own (ADR-0068). A chevron opens the words it was made from, the voice, the cost, when it was made,
 * its file and Show in File Explorer. While ElevenLabs makes it the line says so; when it was not made it says what
 * happened, that nothing was saved and what was counted. Part of the `plugins` Owl feature: with it off the line is not
 * there at all.
 */
export function SoundLine({ soundId, name }: { readonly soundId: string; readonly name: string }): ReactNode {
  const on = useOwlFeature('plugins')
  const [view, reread] = useSoundView(soundId, on)
  const reduced = useReducedMotion(on)
  if (!on) return null
  return <Line soundId={soundId} name={name} view={view} reread={reread} reduced={reduced} />
}

/** A sound's view as main last sent it: undefined until it answers, null when it holds no such sound; and a way to read it again. */
function useSoundView(id: string, on: boolean): readonly [SoundView | null | undefined, () => void] {
  const [view, setView] = useState<SoundView | null | undefined>(undefined)
  const [asked, setAsked] = useState(0)
  useEffect(() => {
    if (!on) return undefined
    const plugins = window.sotto?.plugins
    if (!plugins?.sound) { setView(null); return undefined }
    let live = true
    let heard = false
    const stop = plugins.onSoundChanged?.(next => { if (live && next.id === id) { heard = true; setView(next) } })
    // A change heard while the read was on its way is newer than the read.
    plugins.sound(id).then(found => { if (live && !heard) setView(found) }, () => { if (live && !heard) setView(null) })
    return () => { live = false; stop?.() }
  }, [id, on, asked])
  const reread = useCallback(() => { setAsked(value => value + 1) }, [])
  return [view, reread] as const
}

/** "0:08": a length or a place in it, in minutes and seconds. */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** A cost in US dollars as the line says it: "about $0.08", or "under $0.01". */
function costWords(cost: number): string {
  const figure = dollarFigure(cost)
  return figure ? t({ message: `about ${figure}`, comment: '{figure} is a cost in US dollars, such as $0.08.' }) : t`under $0.01`
}

function kindWords(kind: SoundKind): string {
  return kind === 'speech' ? t`Speech` : kind === 'effect' ? t`Sound effect` : t`Music`
}

function makingWords(kind: SoundKind): string {
  return kind === 'speech' ? t`Making the speech with ElevenLabs…` : kind === 'effect' ? t`Making the sound effect with ElevenLabs…` : t`Making the music with ElevenLabs…`
}

/** The folder app by its own name on each platform, as a file's Show in button says it. */
function revealWords(): string {
  const platform = (window.sotto as { platform?: string } | undefined)?.platform
  if (platform === 'linux') return t`Show in file manager`
  return platform === 'darwin' ? t`Show in Finder` : t`Show in File Explorer`
}

function KindIcon({ kind }: { readonly kind: SoundKind }): ReactNode {
  return kind === 'speech' ? <AudioLines size={22} aria-hidden="true" /> : kind === 'effect' ? <Zap size={22} aria-hidden="true" /> : <Music size={22} aria-hidden="true" />
}

/** Why Play does nothing: the file is gone from its folder, or Sotto could not play what is there. */
type PlayProblem = 'gone' | 'unplayable'

/**
 * The MP3 as one press of Play asks for it: nothing is fetched and no audio element exists until then. The element the
 * press makes is never on the page and never told to play by anything but a press. Its address is let go when the line
 * goes.
 */
function usePlayer(soundId: string, reread: () => void) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const address = useRef<string | null>(null)
  const live = useRef(true)
  const [fetching, setFetching] = useState(false)
  const [started, setStarted] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [at, setAt] = useState(0)
  const [length, setLength] = useState<number>()
  const [problem, setProblem] = useState<PlayProblem>()

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      const element = audio.current
      audio.current = null
      if (element) { element.pause(); element.removeAttribute('src') }
      if (address.current) URL.revokeObjectURL(address.current)
      address.current = null
    }
  }, [])

  const start = (element: HTMLAudioElement): void => {
    void element.play().catch(() => { if (live.current) setPlaying(false) })
  }

  const press = async (): Promise<void> => {
    const element = audio.current
    if (element) {
      if (playing) element.pause()
      else start(element)
      return
    }
    if (fetching) return
    setFetching(true)
    const bytes = await window.sotto?.plugins?.soundBytes?.(soundId).catch(() => null) ?? null
    if (!live.current) return
    setFetching(false)
    if (!bytes) {
      // Main would not hand it over: the file went since the line was drawn, or what is there is not one Sotto plays.
      // The view is read again, which says which.
      setProblem('unplayable')
      reread()
      return
    }
    const made = document.createElement('audio')
    made.preload = 'metadata'
    const known = (): void => { if (Number.isFinite(made.duration) && made.duration > 0) setLength(made.duration) }
    made.addEventListener('loadedmetadata', known)
    made.addEventListener('durationchange', known)
    made.addEventListener('timeupdate', () => { setAt(made.currentTime) })
    made.addEventListener('play', () => { setPlaying(true) })
    made.addEventListener('pause', () => { setPlaying(false) })
    made.addEventListener('ended', () => { setPlaying(false); setAt(Number.isFinite(made.duration) ? made.duration : made.currentTime) })
    made.addEventListener('error', () => { setPlaying(false); setProblem('unplayable') })
    address.current = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'audio/mpeg' }))
    made.src = address.current
    audio.current = made
    setStarted(true)
    start(made)
  }

  const seek = (seconds: number): void => {
    const element = audio.current
    if (!element) return
    element.currentTime = seconds
    setAt(seconds)
  }

  return { press, seek, fetching, playing, at, length, problem, started }
}

function Line({ soundId, name, view, reread, reduced }: {
  readonly soundId: string; readonly name: string; readonly view: SoundView | null | undefined; readonly reread: () => void; readonly reduced: boolean
}): ReactNode {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const bodyId = useId()
  const player = usePlayer(soundId, reread)
  const shown = view?.name ?? name

  const making = view?.state === 'making'
  const made = view?.state === 'made'
  const failed = view?.state === 'failed'
  const gone = view ? soundFileGone(view) : false
  // Gone wins over a file Sotto could not play: once the view says it went, the line says so.
  const problem: PlayProblem | undefined = gone ? 'gone' : player.problem
  const opens = made || failed
  const close = useCallback(() => { setOpen(false); toggle.current?.focus() }, [])

  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  const sub = view === undefined ? t`Sound`
    : view === null ? t`Sotto no longer holds this sound.`
      : made ? [kindWords(view.kind), problem === 'gone' ? t`File gone` : problem === 'unplayable' ? t`Sotto could not play this file` : player.length !== undefined ? clock(player.length) : undefined,
        costWords(view.cost), 'ElevenLabs'].filter(Boolean).join(' · ')
        : failed ? failedLine(view)
          : undefined
  const scrubbing = made && player.started && (player.playing || player.at > 0)
  const playLabel = player.playing ? t({ message: `Pause ${shown}`, comment: '{shown} is the name of a sound, such as Opening narration.' })
    : t({ message: `Play ${shown}`, comment: '{shown} is the name of a sound, such as Opening narration.' })

  return <div className="sound-line" role="group" aria-label={t({ message: `Sound: ${shown}`, comment: '{shown} is the name of a sound, such as Opening narration.' })}
    data-open={open && opens ? 'true' : 'false'} onKeyDown={keyDown}>
    <div className="sound-line__row">
      <span className={failed ? 'sound-line__tile sound-line__tile--failed' : 'sound-line__tile'} aria-hidden="true">
        {failed ? <TriangleAlert size={22} /> : view ? <KindIcon kind={view.kind} /> : <AudioLines size={22} />}
      </span>
      <span className="sound-line__text">
        <b className="sound-line__name">{shown}</b>
        {making ? <>
          <span className="sound-line__sub">{makingWords(view.kind)}</span>
          <span className={reduced ? 'sound-line__busy sound-line__busy--still' : 'sound-line__busy'} role="progressbar"
            aria-label={kindMakingLabel(view.kind)}><i /></span>
        </> : <span className={failed ? 'sound-line__sub sound-line__sub--failed' : 'sound-line__sub'}>{sub}</span>}
      </span>
      {made && <button type="button" className="sound-line__button sound-line__play" aria-label={playLabel} disabled={problem !== undefined}
        aria-busy={player.fetching || undefined} onClick={() => { void player.press() }}>
        {player.playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        <span className="sound-line__label" aria-hidden="true">{player.playing ? t`Pause` : t`Play`}</span>
      </button>}
      {made && <button ref={toggle} type="button" className="sound-line__button sound-line__toggle" aria-expanded={open} aria-controls={bodyId}
        aria-label={open ? t`Hide the details` : t`Show the details`} onClick={() => setOpen(value => !value)}>
        <ChevronDown size={16} aria-hidden="true" />
      </button>}
      {failed && <button ref={toggle} type="button" className="sound-line__button sound-line__toggle sound-line__toggle--words" aria-expanded={open} aria-controls={bodyId}
        onClick={() => setOpen(value => !value)}>
        <span>{open ? t`Hide what happened` : t`Show what happened`}</span><ChevronDown size={16} aria-hidden="true" />
      </button>}
    </div>
    {scrubbing && <Scrubber name={shown} at={player.at} length={player.length} onSeek={player.seek} />}
    {opens && <div className="sound-line__body" id={bodyId} hidden={!open}>
      {open && view && (failed ? <Failed view={view} /> : <Details soundId={soundId} view={view} />)}
    </div>}
  </div>
}

function kindMakingLabel(kind: SoundKind): string {
  return kind === 'speech' ? t`Making the speech` : kind === 'effect' ? t`Making the sound effect` : t`Making the music`
}

/** Where it is while it plays and once it has played: a thin range to move through it, with the place and the length. */
function Scrubber({ name, at, length, onSeek }: { readonly name: string; readonly at: number; readonly length: number | undefined; readonly onSeek: (seconds: number) => void }): ReactNode {
  const { t } = useLingui()
  const end = length ?? Math.max(at, 0)
  const place = clock(at)
  const whole = length !== undefined ? clock(length) : undefined
  return <div className="sound-line__scrub">
    <span className="sound-line__clock">{place}</span>
    <input className="sound-line__range" type="range" min={0} max={end > 0 ? end : 1} step="any" value={Math.min(at, end > 0 ? end : 1)}
      disabled={length === undefined}
      aria-label={t({ message: `Place in ${name}`, comment: '{name} is the name of a sound, such as Opening narration.' })}
      aria-valuetext={whole ? t({ message: `${place} of ${whole}`, comment: 'A place in a sound and its length, such as 0:03 of 0:08.' }) : place}
      onChange={(event: ChangeEvent<HTMLInputElement>) => { onSeek(Number(event.target.value)) }} />
    {whole && <span className="sound-line__clock">{whole}</span>}
  </div>
}

/** The details a press of the chevron opens: the words, the voice, the cost and when, the file and Show in File Explorer. */
function Details({ soundId, view }: { readonly soundId: string; readonly view: SoundView }): ReactNode {
  const { t } = useLingui()
  const [status, setStatus] = useState('')
  const gone = soundFileGone(view)
  const said = view.words
  const voice = view.voice
  const words = said === undefined ? undefined
    : view.kind === 'speech' ? `“${said}”` : t({ message: `Made from “${said}”`, comment: '{said} is what a sound effect or music was made from, in the words sent.' })
  const when = view.madeAt ? new Date(view.madeAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : undefined
  const facts = [
    view.kind === 'speech' && voice ? t({ message: `Spoken in the voice ${voice}`, comment: '{voice} is the name of an ElevenLabs voice, such as Rachel.' }) : undefined,
    costWords(view.cost),
    when ? t({ message: `made ${when}`, comment: '{when} is the time a sound was saved, such as 6:52 pm.' }) : undefined,
  ].filter(Boolean).join(' · ')
  const reveal = (): void => {
    setStatus('')
    const answer = (shown: boolean): void => { setStatus(shown ? '' : t`Sotto could not find the file. It may have been moved or deleted.`) }
    void window.sotto?.plugins?.revealSound?.(soundId).then(answer, () => answer(false))
  }
  return <div className="sound-line__details">
    {words && <p className="sound-line__words">{words}</p>}
    <p className="sound-line__facts">{facts}</p>
    <div className="sound-line__chips">
      <span className="sound-line__chip" title={view.fileName}>
        <span className="sound-line__extension">.mp3</span>{gone || view.bytes === undefined ? t`File gone` : sizeWords(view.bytes)}
      </span>
      {!gone && <button type="button" className="sound-line__chip sound-line__chip--button" onClick={reveal}>
        <FolderOutput size={14} aria-hidden="true" />{revealWords()}
      </button>}
    </div>
    {status && <p className="sound-line__status" role="status">{status}</p>}
  </div>
}

/** What happened to a sound that was not saved, for the user, from what the tool tells its agent. */
function Failed({ view }: { readonly view: SoundView }): ReactNode {
  const { t } = useLingui()
  const charged = view.cost > 0
  const cost = costWords(view.cost)
  const name = view.name
  return <div className="sound-line__problem">
    <TriangleAlert size={16} aria-hidden="true" />
    <p><b>{charged ? t({ message: `The ${name} was not saved.`, comment: '{name} is the name of a sound, such as Opening narration.' })
      : t({ message: `The ${name} was not made.`, comment: '{name} is the name of a 3D model or a sound, such as Oak barrel or Opening narration.' })}</b></p>
    <p>{charged ? <>{unsavedWords(view.failure)} {t`Sotto saved no file.`} {t({ message: `Its cost, ${cost}, was counted against this month’s limit.`, comment: '{cost} is a cost in US dollars, such as about $0.08.' })}</>
      : <>{happenedWords(view.failure, view.kind)} {t`Sotto saved no file, and nothing was counted against this month’s limit.`}</>}</p>
  </div>
}

/** Why ElevenLabs made nothing, as the tool tells its agent. */
function happenedWords(failure: SoundFailure | undefined, kind: SoundKind): string {
  switch (failure) {
    case 'refused': return t`ElevenLabs did not accept the ElevenLabs account’s key, or the key may not do this. Replace it in Settings > Plugins.`
    case 'no-credits': return t`The ElevenLabs account has no credits left for this.`
    case 'rejected': return kind === 'speech' ? t`ElevenLabs would not make this speech from these words in this voice.`
      : kind === 'effect' ? t`ElevenLabs would not make this sound effect from these words.` : t`ElevenLabs would not make this music from these words.`
    case 'busy': return t`ElevenLabs was turning requests away. The agent can ask again in a few minutes.`
    case 'unreadable': return t`ElevenLabs gave an answer Sotto could not read.`
    case 'folder': return t`The folder would not take the file: it is not inside the thread’s folder, or could not be written.`
    case 'too-large': return t`The sound ElevenLabs sent back was larger than Sotto takes.`
    case 'no-account': return t`The ElevenLabs account was removed before the sound was made.`
    case 'locked': return t`Sotto could not read the ElevenLabs account’s key, because this computer’s credential store was locked.`
    default: return t`ElevenLabs could not be reached, or stopped before the whole sound came back.`
  }
}

/** Why a sound ElevenLabs charged for was not saved (Bug Bot on #2648, L1), or that Sotto stopped while it was made. */
function unsavedWords(failure: SoundFailure | undefined): string {
  switch (failure) {
    case 'stopped': return t`Sotto stopped while the sound was being made, so it cannot tell whether ElevenLabs made it.`
    case 'folder': return t`ElevenLabs made it and charged for it, but the folder would not take the file: it is not inside the thread’s folder, or could not be written.`
    case 'too-large': return t`ElevenLabs made it and charged for it, but it was larger than Sotto saves.`
    default: return t`ElevenLabs made it and charged for it, but its answer stopped before the whole file arrived.`
  }
}

/** The line of a sound that was not saved: that, that nothing was saved, and what was counted. */
function failedLine(view: SoundView): string {
  if (view.cost <= 0) return [t`Could not make it`, t`nothing saved`, t`nothing spent`].join(' · ')
  const cost = costWords(view.cost)
  const what = view.failure === 'stopped' ? t`Sotto stopped before it was saved` : t`Could not save it`
  return [what, t`nothing saved`, t({ message: `${cost} counted`, comment: '{cost} is a cost in US dollars, such as about $0.08.' })].join(' · ')
}
