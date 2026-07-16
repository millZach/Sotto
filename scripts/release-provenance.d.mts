export interface BuildArtifactProvenance {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface BuildProvenance {
  readonly version: 1
  readonly sourceCommit: string
  readonly buildSha256: string
  readonly artifacts: readonly BuildArtifactProvenance[]
}

export function readSourceCommit(repositoryRoot: string): string

export function writeBuildProvenance(options: {
  readonly outRoot: string
  readonly sourceCommit: string
}): Promise<BuildProvenance>

export function verifyBuildProvenance(options: {
  readonly outRoot: string
  readonly asarPath: string
  readonly sourceCommit: string
}): Promise<BuildProvenance>

export function fileSha256(path: string): Promise<{
  readonly bytes: number
  readonly sha256: string
}>
