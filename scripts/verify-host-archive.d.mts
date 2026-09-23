export interface HostArtifact { path: string; bytes: number; sha256: string }
export function sha256(value: string | Uint8Array): string
export function inventoryFiles(root: string, directory?: string): Promise<HostArtifact[]>
export function verifyHostArchive(directory: string): Promise<{
  root: string
  manifest: { version: 1; kind: 'sotto-host'; sottoVersion: string; node: string; dependencies: Record<string, string> }
  provenance: { version: 1; sourceCommit: string; buildInputsRevision: string; buildSha256: string; artifacts: HostArtifact[] }
}>
