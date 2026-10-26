// The launch film: shots of the real app framed by a virtual camera, with captions, key caps and an end card.
import React from 'react'
import { AbsoluteFill, Easing, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion'
import { captions, END_CARD, keyCaps, shots } from './edit'
import type { Rect, Region, Shot } from './timeline'

export const INK = 'oklch(0.115 0.008 265)'
export const TEXT = 'oklch(0.985 0.005 280)'
export const TEAL = 'oklch(0.714403 0.104089 183.092)'
const MUTED = 'oklch(0.80 0.012 265)'
const SOURCE = { width: 2560, height: 1600 }
const ease = Easing.bezier(0.45, 0, 0.2, 1)

export const fontFace = `@font-face { font-family: 'Figtree'; font-style: normal; font-weight: 300 900; src: url('${staticFile('fonts/figtree-latin.woff2')}') format('woff2'); }`

/** Where a shot's crop lands in the 1080x1920 frame: its keyframes' own region, or the frame's default. */
function regionOf(shot: Shot, rect: Rect, out?: Region): Region {
  if (out) return out
  if (shot.frame === 'window') return { y: shot.y ?? 420, h: 1080 * rect.h / rect.w }
  return { y: shot.y ?? 190, h: shot.h ?? 1080 }
}

/** The crop and region at progress p (0..1) through the shot, eased between its keyframes. */
function cameraAt(shot: Shot, p: number): { rect: Rect; out: Region } {
  const keys = shot.camera
  const at = (i: number) => ({ rect: keys[i].rect, out: regionOf(shot, keys[i].rect, keys[i].out) })
  if (keys.length === 1 || p <= keys[0].t) return at(0)
  for (let i = 1; i < keys.length; i++) {
    if (p <= keys[i].t) {
      const a = at(i - 1), b = at(i), k = ease((p - keys[i - 1].t) / (keys[i].t - keys[i - 1].t))
      const mix = (x: number, y: number) => x + (y - x) * k
      return { rect: { x: mix(a.rect.x, b.rect.x), y: mix(a.rect.y, b.rect.y), w: mix(a.rect.w, b.rect.w), h: mix(a.rect.h, b.rect.h) }, out: { y: mix(a.out.y, b.out.y), h: mix(a.out.h, b.out.h) } }
    }
  }
  return at(keys.length - 1)
}

const ShotView: React.FC<{ shot: Shot }> = ({ shot }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const length = (shot.end - shot.start) * fps
  const { rect, out } = cameraAt(shot, Math.min(1, frame / Math.max(1, length - 1)))
  const target = { x: 0, y: out.y, w: 1080, h: out.h }
  // The crop fills the region: the wider of the two fits decides the scale, and the crop is centred in it.
  const scale = Math.max(target.w / rect.w, target.h / rect.h)
  const offsetX = target.x + (target.w - rect.w * scale) / 2 - rect.x * scale
  const offsetY = target.y + (target.h - rect.h * scale) / 2 - rect.y * scale
  const source = shot.still
    ? <Img src={staticFile(shot.still)} style={{ position: 'absolute', left: 0, top: 0, width: SOURCE.width, height: SOURCE.height }} />
    : <OffthreadVideo src={staticFile(`takes/${shot.take}.mp4`)} startFrom={Math.round(shot.from * fps)} playbackRate={shot.rate ?? 1} muted
        style={{ position: 'absolute', left: 0, top: 0, width: SOURCE.width, height: SOURCE.height }} />
  return (
    <AbsoluteFill style={{ backgroundColor: INK }}>
      <div style={{ position: 'absolute', left: target.x, top: target.y, width: target.w, height: target.h, overflow: 'hidden',
        borderRadius: shot.frame === 'window' ? 14 : 0, boxShadow: shot.frame === 'window' ? '0 0 0 1px oklch(0.305 0.02 265)' : undefined }}>
        <div style={{ position: 'absolute', left: offsetX - target.x, top: offsetY - target.y, width: SOURCE.width, height: SOURCE.height, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
          {source}
        </div>
      </div>
      {shot.frame === 'tight' ? <Feather top={target.y} height={target.h} /> : null}
    </AbsoluteFill>
  )
}

/** A soft edge where a tight crop meets the Ink, so the cut edge of the UI doesn't read as a hard line. */
const Feather: React.FC<{ top: number; height: number }> = ({ top, height }) => (
  <>
    <div style={{ position: 'absolute', left: 0, right: 0, top, height: 60, background: `linear-gradient(${INK}, transparent)` }} />
    <div style={{ position: 'absolute', left: 0, right: 0, top: top + height - 90, height: 90, background: `linear-gradient(transparent, ${INK})` }} />
  </>
)

const Caption: React.FC<{ text: string; length: number; y?: number }> = ({ text, length, y }) => {
  const frame = useCurrentFrame()
  const opacity = interpolate(frame, [0, 8, length - 8, length], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const lift = interpolate(frame, [0, 12], [10, 0], { extrapolateRight: 'clamp', easing: ease })
  return (
    <div style={{ position: 'absolute', left: 90, right: 120, top: y ?? 1320, display: 'flex', justifyContent: 'center', opacity, transform: `translateY(${lift}px)` }}>
      <div style={{ fontFamily: 'Figtree', fontWeight: 600, fontSize: 68, lineHeight: 1.18, color: TEXT, textAlign: 'center', letterSpacing: -0.5, textWrap: 'balance',
        padding: '14px 28px', borderRadius: 22, background: 'oklch(0.115 0.008 265 / 0.72)' }}>{text}</div>
    </div>
  )
}

const KeyCaps: React.FC<{ keys: string[]; length: number; y?: number }> = ({ keys, length, y }) => {
  const frame = useCurrentFrame()
  const opacity = interpolate(frame, [0, 4, length - 8, length], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const press = interpolate(frame, [0, 5, 10], [1, 0.94, 1], { extrapolateRight: 'clamp' })
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: y ?? 1150, display: 'flex', justifyContent: 'center', gap: 18, opacity }}>
      {keys.map(key => (
        <div key={key} style={{ fontFamily: 'Figtree', fontWeight: 600, fontSize: 44, color: TEXT, padding: '14px 26px', minWidth: 60, textAlign: 'center',
          borderRadius: 16, background: INK, border: `2px solid ${TEAL}`, boxShadow: '0 6px 18px oklch(0 0 0 / 0.5)', transform: `scale(${press})` }}>{key}</div>
      ))}
    </div>
  )
}

const EndCard: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const at = (seconds: number, span = 0.5) => interpolate(frame, [seconds * fps, (seconds + span) * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease })
  const rise = (seconds: number) => ({ opacity: at(seconds), transform: `translateY(${(1 - at(seconds)) * 14}px)` })
  return (
    <AbsoluteFill style={{ backgroundColor: INK, alignItems: 'center', fontFamily: 'Figtree', color: TEXT }}>
      <div style={{ position: 'absolute', top: 470, display: 'flex', flexDirection: 'column', alignItems: 'center', ...rise(0) }}>
        <Img src={staticFile('icon.png')} style={{ width: 220, height: 220, borderRadius: 48 }} />
        <div style={{ fontWeight: 700, fontSize: 96, marginTop: 34, letterSpacing: -1 }}>Sotto</div>
      </div>
      <div style={{ position: 'absolute', top: 930, left: 110, right: 130, textAlign: 'center', fontWeight: 600, fontSize: 56, lineHeight: 1.22, textWrap: 'balance', ...rise(END_CARD.tagline) }}>
        Your coding agents in one desktop window, with dictation built in.
      </div>
      <div style={{ position: 'absolute', top: 1200, left: 90, right: 120, textAlign: 'center', fontWeight: 500, fontSize: 32, color: MUTED, whiteSpace: 'nowrap', ...rise(END_CARD.facts) }}>
        Free and open source · Windows and macOS · No account
      </div>
      <div style={{ position: 'absolute', top: 1290, left: 90, right: 120, textAlign: 'center', fontWeight: 600, fontSize: 40, color: TEAL, ...rise(END_CARD.url) }}>
        github.com/millZach/Sotto-releases
      </div>
    </AbsoluteFill>
  )
}

export const Film: React.FC = () => {
  const { fps } = useVideoConfig()
  const f = (s: number) => Math.round(s * fps)
  return (
    <AbsoluteFill style={{ backgroundColor: INK }}>
      <style>{fontFace}</style>
      {shots.map(shot => (
        <Sequence key={shot.id} from={f(shot.start)} durationInFrames={f(shot.end) - f(shot.start)} name={shot.id}>
          <ShotView shot={shot} />
        </Sequence>
      ))}
      <Sequence from={f(END_CARD.start)} name="end card"><EndCard /></Sequence>
      {captions.map(c => (
        <Sequence key={c.text} from={f(c.start)} durationInFrames={f(c.end) - f(c.start)} name={`caption: ${c.text}`}>
          <Caption text={c.text} length={f(c.end) - f(c.start)} y={c.y} />
        </Sequence>
      ))}
      {keyCaps.map((k, i) => (
        <Sequence key={i} from={f(k.at)} durationInFrames={f(k.hold ?? 0.6)} name={`keys: ${k.keys.join(' ')}`}>
          <KeyCaps keys={k.keys} length={f(k.hold ?? 0.6)} y={k.y} />
        </Sequence>
      ))}
    </AbsoluteFill>
  )
}
