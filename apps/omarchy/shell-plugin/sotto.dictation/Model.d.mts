// Types for Model.mjs, which the shell plugin's QML imports and the unit tests check.
export type DictationStatus = 'idle' | 'starting' | 'listening' | 'transcribing' | 'delivered' | 'copied' | 'failed'
export type Edge = 'top' | 'bottom' | 'left' | 'right'
export type Verb = 'toggle' | 'stop' | 'cancel' | 'retry' | 'discard' | 'place'
export type Button = 'stop' | 'cancel' | 'retry' | 'discard' | 'dismiss'

export interface DictationRecord {
  state: DictationStatus
  since: number
  updatedAt: number
  detail: string
  kept: boolean
  edge: Edge
  pid: number
}
export interface Area { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }
export interface PillLook { glyph: string; tone: '' | 'live' | 'error'; message: string; buttons: Button[] }
export interface BarLook { glyph: string; alert: boolean; time: boolean; tooltip: string }

export const STATES: readonly DictationStatus[]
export const EDGES: readonly Edge[]
export const ACTIVE: readonly DictationStatus[]
export const HOLD_MS: Readonly<Partial<Record<DictationStatus, number>>>
export const NOTICE_MS: number
export const PROCESS_CHECK_MS: number
export const GLYPH: Readonly<Record<'sand' | 'check' | 'copy' | 'alert', string>>
export const BUTTON_TEXT: Readonly<Record<Button, string>>
export const BUTTON_NAME: Readonly<Record<Button, string>>

export function idle(edge?: unknown): DictationRecord
export function validEdge(edge: unknown): boolean
export function finiteNumber(value: unknown): number
export function processId(value: unknown): number
export function parse(text: unknown): DictationRecord
export function key(record: Pick<DictationRecord, 'state' | 'since'>): string
export function startsDictation(previous: DictationRecord | null, next: DictationRecord | null): boolean
export function displayFor(current: string, previous: DictationRecord | null, next: DictationRecord | null, shown: boolean, focused: string): string
export function effectiveState(record: DictationRecord | null, now: number, dismissedKey: string): DictationStatus
export function nextExpiry(record: DictationRecord | null, now: number): number
export function watchesProcess(record: DictationRecord | null): boolean
export function processGone(stat: string | null | undefined, pid: number): boolean
export function lostNotice(record: DictationRecord | null): string
export function formatElapsed(since: number, now: number): string
export function buttonsFor(state: DictationStatus, record: DictationRecord | null): Button[]
export function pillFor(state: DictationStatus, record: DictationRecord, notice?: string, lost?: boolean): PillLook
export function barFor(state: DictationStatus, record: DictationRecord): BarLook
export function workArea(width: number, height: number, barPosition: string, barSize: number): Area
export function verticalEdge(edge: string): boolean
export function maxLength(edge: string, area: Area, gap: number): number
export function messageWidth(length: number, fixed: number, preferred: number, minimum: number): number
export function sentenceLines(message: string, width: number, measure: (text: string) => number): { text: string; width: number }
export function restingPosition(edge: string, area: Area, width: number, height: number, gap: number): Point
export function snapEdge(bounds: Area, area: Area): Edge
export function animationsEnabled(text: unknown): boolean
export function clamp(value: number, minimum: number, maximum: number): number
export function commandFrom(barConfig: unknown, pluginId: string): string
export function cleanCommand(value: unknown): string
export function failureNotice(verb: Verb, started: boolean, state: DictationStatus): string
export function noticeHolds(verb: Verb, state: DictationStatus): boolean
