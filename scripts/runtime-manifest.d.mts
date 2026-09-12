export const RUNTIME_FILE_ALLOWLIST: readonly string[]
export interface RuntimeFile { path: string; bytes: number; sha256: string }
export interface RuntimeManifest { version: 1; files: RuntimeFile[] }
export function validateRuntimeManifest(value: unknown): RuntimeManifest
