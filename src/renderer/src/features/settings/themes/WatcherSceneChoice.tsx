import React, { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

import { WATCHER_SCENES, type WatcherScene } from '../../../../../shared/watcherScene'
import { useReducedMotion } from '../../../state/reducedMotion'
import { useWatcherEnabled } from '../../../state/watcherFeature'
import { toRgb } from '../../../watcher/canvasColor'
import { sceneInk, type SceneInk } from '../../../watcher/nightScene'
import { SceneThumbnail } from '../../../watcher/sceneThumbnail'
import './watcherSceneChoice.css'

/** Each place's name, and what its card says of it under the name. */
const PLACE_WORDS = {
  'night-wood': msg`Hills, a river, the moon and a broad tree.`,
  harbour: msg`The sea, a ship at the quay and a lighthouse.`,
  snowfield: msg`Snowy pines and falling snow under the northern lights.`,
  desert: msg`Dunes, tall cactus and a big moon.`,
} as const satisfies Record<WatcherScene, unknown>

const PLACE_NAMES = {
  'night-wood': msg({ message: 'Night wood', comment: 'A place Watcher’s night scene can be set in' }),
  harbour: msg({ message: 'Harbour', comment: 'A place Watcher’s night scene can be set in' }),
  snowfield: msg({ message: 'Snowfield', comment: 'A place Watcher’s night scene can be set in' }),
  desert: msg({ message: 'Desert', comment: 'A place Watcher’s night scene can be set in' }),
} as const satisfies Record<WatcherScene, unknown>

/**
 * Settings → Appearance → Watcher scene (ADR-0148): the place Watcher's night scene is set in, as a card for each with
 * its picture drawn by the scene's own painter in the theme's inks. A radio group: one Tab stop, the arrows, Home and
 * End move to a place and choose it. Shown only where Watcher is (ADR-0072); elsewhere the saved choice is kept whole.
 */
export function WatcherSceneChoice({ value, onChoose }: {
  readonly value: WatcherScene
  /** Saves the place; resolves false when it was not saved. */
  readonly onChoose: (scene: WatcherScene) => Promise<boolean>
}): ReactNode {
  const watcher = useWatcherEnabled()
  return watcher ? <SceneCards value={value} onChoose={onChoose} /> : null
}

function SceneCards({ value, onChoose }: { readonly value: WatcherScene; readonly onChoose: (scene: WatcherScene) => Promise<boolean> }): ReactNode {
  const { t, i18n } = useLingui()
  const headingId = useId()
  const hintId = useId()
  // The choice shows at once; the saved value takes over when it arrives, and comes back when the save fails.
  const [chosen, setChosen] = useState(value)
  const saved = useRef(value)
  useEffect(() => { saved.current = value; setChosen(value) }, [value])
  const buttons = useRef(new Map<WatcherScene, HTMLButtonElement>())
  const ink = useSceneInk()

  const choose = (scene: WatcherScene, focus: boolean): void => {
    if (focus) buttons.current.get(scene)?.focus()
    if (scene === chosen) return
    setChosen(scene)
    void onChoose(scene).then(ok => { if (!ok) setChosen(saved.current) }, () => setChosen(saved.current))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // From the card that has focus, which is the chosen one unless something else put focus elsewhere.
    const from = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-scene]')?.dataset.scene : undefined
    const at = WATCHER_SCENES.indexOf((WATCHER_SCENES as readonly string[]).includes(from ?? '') ? from as WatcherScene : chosen), last = WATCHER_SCENES.length - 1
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (at + 1) % WATCHER_SCENES.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (at + last) % WATCHER_SCENES.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? last : null
    if (next === null) return
    event.preventDefault()
    choose(WATCHER_SCENES[next]!, true)
  }

  return (
    <div className="watcher-scene-choice" data-setting="watcher-scene">
      <h3 className="theme-settings__subheading" id={headingId}><Trans>Watcher scene</Trans></h3>
      <p className="theme-settings__assignment-hint tt-paragraph" id={hintId}><Trans>Where Watcher and the owls for your threads live. Its colors come from your theme.</Trans></p>
      <div className="watcher-scene-choice__grid" role="radiogroup" aria-labelledby={headingId} aria-describedby={hintId} onKeyDown={onKeyDown}>
        {WATCHER_SCENES.map(id => {
          const active = id === chosen
          const place = i18n._(PLACE_NAMES[id])
          return (
            <button
              key={id}
              ref={button => { if (button === null) buttons.current.delete(id); else buttons.current.set(id, button) }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              data-scene={id}
              className="watcher-scene-option tt-focusable"
              aria-label={active ? t`Set Watcher’s scene in ${place}, in use` : t`Set Watcher’s scene in ${place}`}
              onClick={() => choose(id, false)}
            >
              <ScenePicture place={id} ink={ink} />
              <span className="watcher-scene-option__name">
                {place}{active ? <span className="watcher-scene-option__now"> · <Trans>In use</Trans></span> : null}
              </span>
              <span className="watcher-scene-option__words">{i18n._(PLACE_WORDS[id])}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The scene's inks for the theme showing now, and its glyph face, read again whenever the theme or mode changes. */
interface ThumbnailInk { readonly ink: SceneInk; readonly font: string; readonly key: string }

function useSceneInk(): ThumbnailInk | null {
  const [ink, setInk] = useState<ThumbnailInk | null>(null)
  useEffect(() => {
    // Without layout (a test's DOM) there is no canvas to read colours with, and nothing is drawn.
    if (typeof ResizeObserver === 'undefined') return
    const probe = document.createElement('i')
    probe.className = 'watcher-scene-choice__ink'
    probe.setAttribute('aria-hidden', 'true')
    document.body.append(probe)
    const pixelCanvas = document.createElement('canvas')
    pixelCanvas.width = 1; pixelCanvas.height = 1
    const pixel = pixelCanvas.getContext('2d', { willReadFrequently: true })
    let disposed = false
    const read = (): void => {
      if (pixel === null || disposed) return
      const style = getComputedStyle(probe)
      const text = toRgb(style.color, pixel), accent = toRgb(style.backgroundColor, pixel), surface = toRgb(style.outlineColor, pixel)
      if (text === null || accent === null || surface === null) return
      const key = JSON.stringify([text, accent, surface, style.fontFamily])
      setInk(current => current?.key === key ? current : { ink: sceneInk(surface, text, accent), font: style.fontFamily, key })
    }
    read()
    const theme = new MutationObserver(read)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'data-theme-id'] })
    // The glyph face may still be loading; the pictures are drawn again once it has.
    void document.fonts?.load(`10.5px ${getComputedStyle(probe).fontFamily}`).then(() => { if (!disposed) { setInk(null); read() } }, () => undefined)
    return () => { disposed = true; theme.disconnect(); probe.remove() }
  }, [])
  return ink
}

/** How often a picture moves: its snow, sand and beam are slow, and four pictures share the page. */
const PICTURE_FRAME_MS = 1000 / 12

/**
 * A place's picture, moving as the room does while it is on screen and the window shows; with motion reduced, or in a
 * test's capture, it is drawn once and holds still. A new theme or place draws over the last picture in one frame.
 */
function ScenePicture({ place, ink }: { readonly place: WatcherScene; readonly ink: ThumbnailInk | null }): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null)
  const reduced = useReducedMotion()
  const still = reduced || window.sottoE2E !== undefined
  useEffect(() => {
    const target = canvas.current
    if (target === null || ink === null) return
    const picture = new SceneThumbnail(place, ink.ink, ink.font, Math.min(2, window.devicePixelRatio || 1))
    picture.paint(target, 0, true)
    if (still || typeof IntersectionObserver === 'undefined') return
    const start = performance.now()
    let onScreen = false, timer: number | null = null
    const tick = (): void => {
      timer = null
      if (!onScreen || document.hidden) return
      picture.paint(target, (performance.now() - start) / 1000, false)
      timer = window.setTimeout(tick, PICTURE_FRAME_MS)
    }
    const resume = (): void => { if (timer === null && onScreen && !document.hidden) tick() }
    const seen = new IntersectionObserver(entries => { onScreen = entries.some(entry => entry.isIntersecting); resume() })
    seen.observe(target)
    document.addEventListener('visibilitychange', resume)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      seen.disconnect()
      document.removeEventListener('visibilitychange', resume)
    }
  }, [place, ink, still])
  return <span className="watcher-scene-option__picture" aria-hidden="true"><canvas ref={canvas} /></span>
}
