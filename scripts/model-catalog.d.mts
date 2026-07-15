export interface ScriptModelCatalogEntry {
  readonly label: string
  readonly repository: string
  readonly revision: string
  readonly dtype: 'q8'
  readonly multilingual: true
  readonly license: 'Apache-2.0'
  readonly bundled: boolean
  readonly encoderBytes: number
  readonly decoderBytes: number
}
export const MODEL_FILE_ALLOWLIST: readonly string[]
export const RUNTIME_FILE_ALLOWLIST: readonly string[]
export const MODEL_CATALOG: Readonly<Record<'fast' | 'balanced' | 'accurate', Readonly<ScriptModelCatalogEntry>>>
export function modelFileUrl(model: ScriptModelCatalogEntry, path: string): string
export interface LockedFile { path: string; url: string; bytes: number; sha256: string }
export interface LockedModel { repository: string; revision: string; license: string; bundled: boolean; files: LockedFile[] }
export interface CatalogLock { version: 1; presets: Record<'fast' | 'balanced' | 'accurate', LockedModel> }
export interface RuntimeFile { path: string; bytes: number; sha256: string }
export interface RuntimeManifest { version: 1; files: RuntimeFile[] }
export function validateCatalogLock(value: unknown): CatalogLock
export function validateBundledManifest(value: unknown, catalog: CatalogLock): unknown
export function validateRuntimeManifest(value: unknown): RuntimeManifest
