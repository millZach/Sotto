export function verifyPreparedAssets(options?: {
  readonly modelRoot?: string
  readonly runtimeRoot?: string
}): Promise<{ readonly modelFiles: number; readonly runtimeFiles: number }>
