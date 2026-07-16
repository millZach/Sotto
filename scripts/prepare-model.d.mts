export interface PrepareFetchOptions extends RequestInit {
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof globalThis.fetch
}
export interface PrepareDownloadOptions extends PrepareFetchOptions { readonly attempts?: number }
export interface PreparedModelSource { readonly repository: string; readonly revision: string }
export interface PreparedFileIntegrity { readonly bytes: number; readonly sha256: string }
export function fetchPinned(url: string | URL, options?: PrepareFetchOptions): Promise<Response>
export function treeMetadata(model: PreparedModelSource, options?: PrepareFetchOptions): Promise<Map<string, unknown>>
export function download(url: string | URL, destination: string, expectedBytes: number, options?: PrepareDownloadOptions): Promise<PreparedFileIntegrity>
export function replaceDirectory(temporary: string, destination: string): Promise<void>
export interface PreparedAssetDirectory { readonly temporary: string; readonly destination: string }
export interface PreparedAssetOperations {
  readonly rename: (from: string, to: string) => Promise<void>
  readonly rm: (path: string, options: { readonly recursive: true; readonly force: true }) => Promise<void>
  readonly exists: (path: string) => Promise<boolean>
}
export function replacePreparedAssetSet(entries: readonly PreparedAssetDirectory[], operations?: PreparedAssetOperations): Promise<void>
