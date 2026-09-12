export function replaceDirectory(temporary: string, destination: string): Promise<void>
export interface PreparedAssetDirectory { readonly temporary: string; readonly destination: string }
export interface PreparedAssetOperations {
  readonly rename: (from: string, to: string) => Promise<void>
  readonly rm: (path: string, options: { readonly recursive: true; readonly force: true }) => Promise<void>
  readonly exists: (path: string) => Promise<boolean>
}
export function replacePreparedAssetSet(entries: readonly PreparedAssetDirectory[], operations?: PreparedAssetOperations): Promise<void>
