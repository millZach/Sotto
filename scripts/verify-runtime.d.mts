export function verifyPreparedAssets(options?: {
  readonly runtimeRoot?: string
}): Promise<{ readonly runtimeFiles: number }>
