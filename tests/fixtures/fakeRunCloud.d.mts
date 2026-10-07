export interface FakeRunCloudAsset {
  id: string
  name: string
  byteSize?: number
}
export interface FakeRunCloudSession {
  id: string
  status: string
  device: string
  osVersion: string
  lastInteraction: Record<string, unknown> | null
  screen: { width: number; height: number; unit: string }
}
export interface FakeRunCloudControl {
  capacityOnce?: boolean
  noPresignOnce?: boolean
  interactionFailOnce?: boolean
  uploadRejectOnce?: boolean
  idOnlyOnce?: boolean
  finalizeFailOnce?: boolean
  echoErrorOnce?: boolean
}
export interface FakeRunCloud {
  url: string
  port: number
  key: string
  control(patch: FakeRunCloudControl): void
  assets: Map<string, FakeRunCloudAsset>
  sessions: Map<string, FakeRunCloudSession>
  close(): Promise<void>
}
export function start(port: number, options?: { key?: string }): Promise<FakeRunCloud>
