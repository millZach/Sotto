export interface NoticeComponent {
  readonly name: string
  readonly version: string
  readonly license: string
  readonly attribution: string
  readonly packagePath?: string
}

export const NOTICE_COMPONENTS: readonly NoticeComponent[]
export const EMBEDDED_BROWSER_DEPENDENCIES: readonly string[]
export function verifyThirdPartyNotices(options?: {
  readonly packagedResources?: string
  readonly asarPath?: string
}): Promise<{ componentCount: number }>
