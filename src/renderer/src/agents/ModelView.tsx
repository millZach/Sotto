import { useLingui } from '@lingui/react/macro'
import { Pause, Play, RotateCcw } from 'lucide-react'
import React, { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { DirectionalLight, Group, HemisphereLight, PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import type { Model3dPart } from '../../../shared/models3d'
import { disposeScene, parseModel } from './modelScene'

/**
 * The turnable view of a 3D model in its thread (ADR-0141; the Meshy plan's ticket 4), loaded only once a line is
 * opened so the window's own code carries none of three.js. It draws the GLB main hands over by the 3D model's ID, and
 * reads nothing else: every picture in it is decoded from its own bytes, never through an address, so a view never
 * loads anything, as main's check that a GLB names no `uri` already promises.
 *
 * It takes focus as it opens. The arrow keys turn it, Home faces it to the front, and Escape closes it. It turns slowly
 * by itself until it is touched, unless motion is reduced.
 */
export interface ModelViewProps {
  readonly modelId: string
  readonly part: Exclude<Model3dPart, 'still'>
  readonly name: string
  readonly reduced: boolean
  readonly onClose: () => void
  /** This window cannot draw WebGL: the line shows the still picture, the name and the files instead. */
  readonly onUnavailable: () => void
}

const STEP = Math.PI / 12
const PITCH_MIN = -0.15
const PITCH_MAX = 1.0
/** The front: a three-quarter view from a little above, as in the prototype, so a model reads as solid. */
const YAW_FRONT = -0.62
const PITCH_FRONT = 0.38
/** The camera's field of view, in degrees, and how much room the model is given around it. */
const FIELD = 35
const MARGIN = 1.18
/** One whole turn in 24 seconds, slow enough to read the model by. */
const AUTO_TURN_PER_MS = (Math.PI * 2) / 24_000

/** Whole degrees turned from the front, 0 to 359. */
const degreesOf = (yaw: number): number => { const degrees = Math.round(((yaw - YAW_FRONT) * 180 / Math.PI) % 360); return degrees < 0 ? degrees + 360 : degrees }

export default function ModelView({ modelId, part, name, reduced, onClose, onUnavailable }: ModelViewProps): ReactNode {
  const { t } = useLingui()
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const turn = useRef({ yaw: YAW_FRONT, pitch: PITCH_FRONT, dirty: true, touched: false, auto: !reduced })
  const drag = useRef<{ readonly x: number; readonly y: number; readonly yaw: number; readonly pitch: number } | null>(null)
  const [degrees, setDegrees] = useState(0)
  const [drawn, setDrawn] = useState<'loading' | 'drawn' | 'unreadable'>('loading')
  const [turning, setTurning] = useState(!reduced)
  const unavailable = useRef(onUnavailable)
  unavailable.current = onUnavailable

  useEffect(() => { host.current?.focus() }, [])
  useEffect(() => { turn.current.auto = turning && !reduced && !turn.current.touched }, [turning, reduced])

  useEffect(() => {
    const element = host.current
    const surface = canvas.current
    if (!element || !surface) return undefined
    let renderer: WebGLRenderer
    try { renderer = new WebGLRenderer({ canvas: surface, antialias: true, alpha: true }) } catch { unavailable.current(); return undefined }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    const scene = new Scene()
    const camera = new PerspectiveCamera(FIELD, 1, 0.05, 50)
    const pivot = new Group()
    scene.add(pivot, new HemisphereLight(0xffffff, 0x444444, 2.2))
    const sun = new DirectionalLight(0xffffff, 1.6)
    sun.position.set(2, 3, 4)
    scene.add(sun)
    let stopped = false
    let frame = 0
    let last = performance.now()
    const size = (): void => {
      const width = Math.max(1, element.clientWidth)
      const height = Math.max(1, element.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      // Far enough back that the model, scaled to fit a sphere of radius one, fits the narrower way with room around it.
      const half = Math.min(FIELD / 2 * Math.PI / 180, Math.atan(Math.tan(FIELD / 2 * Math.PI / 180) * camera.aspect))
      camera.position.set(0, 0, MARGIN / Math.sin(half))
      camera.updateProjectionMatrix()
      turn.current.dirty = true
    }
    const draw = (now: number): void => {
      if (stopped) return
      const held = turn.current
      if (held.auto) { held.yaw += (now - last) * AUTO_TURN_PER_MS; held.dirty = true }
      last = now
      if (held.dirty) {
        pivot.rotation.set(held.pitch, held.yaw, 0)
        renderer.render(scene, camera)
        held.dirty = false
      }
      frame = requestAnimationFrame(draw)
    }
    const resized = new ResizeObserver(size)
    resized.observe(element)
    size()
    frame = requestAnimationFrame(draw)

    void (async () => {
      const bytes = await window.sotto?.plugins?.model3dBytes({ id: modelId, part }).catch(() => null)
      if (stopped) return
      if (!bytes) { setDrawn('unreadable'); return }
      try {
        const model = await parseModel(bytes)
        if (stopped) { disposeScene(model); return }
        pivot.add(model)
        turn.current.dirty = true
        setDrawn('drawn')
      } catch { if (!stopped) setDrawn('unreadable') }
    })()

    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      resized.disconnect()
      disposeScene(scene)
      renderer.dispose()
    }
  }, [modelId, part])

  const moved = (): void => {
    const held = turn.current
    held.touched = true
    held.auto = false
    held.dirty = true
    setTurning(false)
    setDegrees(degreesOf(held.yaw))
  }
  const toFront = (): void => {
    const held = turn.current
    held.yaw = YAW_FRONT
    held.pitch = PITCH_FRONT
    moved()
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const held = turn.current
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
    if (event.key === 'ArrowLeft') held.yaw -= STEP
    else if (event.key === 'ArrowRight') held.yaw += STEP
    else if (event.key === 'ArrowUp') held.pitch = Math.max(PITCH_MIN, held.pitch - 0.1)
    else if (event.key === 'ArrowDown') held.pitch = Math.min(PITCH_MAX, held.pitch + 0.1)
    else if (event.key === 'Home') { event.preventDefault(); toFront(); return }
    else return
    event.preventDefault()
    moved()
  }
  const pointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = { x: event.clientX, y: event.clientY, yaw: turn.current.yaw, pitch: turn.current.pitch }
  }
  const pointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const from = drag.current
    if (!from) return
    turn.current.yaw = from.yaw + (event.clientX - from.x) * 0.01
    turn.current.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, from.pitch + (event.clientY - from.y) * 0.01))
    moved()
  }
  const pointerUp = (): void => { drag.current = null }

  const facing = degrees === 0 ? t`Facing the front` : t({ message: `Turned ${degrees} degrees from the front`, comment: '{degrees} is a whole number from 1 to 359.' })
  return <div className="model-view">
    <div ref={host} className="model-view__stage" tabIndex={0} role="slider" aria-roledescription={t`3D model`}
      aria-label={t({ message: `Turn the ${name}. Drag, or use the arrow keys; Home faces it to the front.`, comment: '{name} is the name of a 3D model, such as Oak barrel.' })}
      aria-valuemin={0} aria-valuemax={359} aria-valuenow={degrees} aria-valuetext={facing} aria-busy={drawn === 'loading'}
      onKeyDown={keyDown} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}>
      <canvas ref={canvas} aria-hidden="true" />
      {drawn === 'drawn' && <span className="model-view__hint" aria-hidden="true">{t`Drag or use the arrow keys to turn`}</span>}
      {drawn === 'unreadable' && <span className="model-view__over"><b>{t`Sotto could not draw this 3D model.`}</b><span>{t`Its file may have been moved or changed. The files are listed below.`}</span></span>}
    </div>
    {drawn === 'drawn' && <span className="model-view__tools">
      {!reduced && <button type="button" className="model-view__tool" onClick={() => { const next = !turning; turn.current.touched = !next; setTurning(next) }}
        aria-label={turning ? t`Stop turning` : t`Turn slowly`} title={turning ? t`Stop turning` : t`Turn slowly`}>{turning ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}</button>}
      <button type="button" className="model-view__tool" onClick={toFront} aria-label={t({ message: `Turn the ${name} back to the front`, comment: '{name} is the name of a 3D model.' })}
        title={t`Face the front`}><RotateCcw size={16} aria-hidden="true" /></button>
    </span>}
  </div>
}
