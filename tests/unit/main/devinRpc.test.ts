// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DevinRejected, devinEnvironment } from '../../../src/main/agents/devinRpc'

describe("Devin stdio boundary", () => {

  it('passes only native account environment, never API routing or billing overrides', () => {
    expect(devinEnvironment({ PATH: 'bin', APPDATA: 'data', HOME: 'home', DEVIN_API_KEY: 'secret', OPENAI_API_KEY: 'secret', DEVIN_BASE_URL: 'elsewhere', NODE_OPTIONS: '--inspect', HTTPS_PROXY: 'proxy' }))
      .toEqual({ PATH: 'bin', APPDATA: 'data', HOME: 'home', HTTPS_PROXY: 'proxy' })
  })

  it('passes the Windows machine-wide data folder so tools like OpenSSH find their system configuration', () => {
    expect(devinEnvironment({ ProgramData: 'C:\\ProgramData', ALLUSERSPROFILE: 'C:\\ProgramData', DEVIN_API_KEY: 'secret' }))
      .toEqual({ ProgramData: 'C:\\ProgramData', ALLUSERSPROFILE: 'C:\\ProgramData' })
  })

  it('retains only safe integer diagnostic codes and the outbound operation', () => {
    expect(new DevinRejected(-32015).message).not.toContain('-32015')
    expect(new DevinRejected(-9999, 'session/load')).toMatchObject({ code: -9999, operation: 'session/load' })
    expect(new DevinRejected(Number.MAX_SAFE_INTEGER + 1).code).toBeUndefined()
  })
})
