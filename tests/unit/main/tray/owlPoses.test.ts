// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  FLAP_SEQUENCES,
  LOOK_CHOICES,
  LOOK_TARGETS,
  OWL_FRAME_MS,
  REST_POSE,
  allOwlPoses,
  blinkSteps,
  glanceSteps,
  lookPose,
  owlFrameIndex,
  poseKey,
} from '../../../../src/main/tray/owl/poses.mjs'

describe('the menu bar owl poses', () => {
  it('lists the resting pose first and every pose once', () => {
    const poses = allOwlPoses()
    expect(poses[0]).toBe(REST_POSE)
    expect(new Set(poses.map(poseKey)).size).toBe(poses.length)
    expect(owlFrameIndex(REST_POSE)).toBe(0)
  })

  it('lists exactly the 73 poses the approved prototype showed', () => {
    expect(allOwlPoses()).toHaveLength(73)
  })

  it('lists a rest and a half and shut blink for every look', () => {
    const keys = new Set(allOwlPoses().map(poseKey))
    for (const look of LOOK_TARGETS) {
      expect(keys.has(poseKey(lookPose(look)))).toBe(true)
      for (const lid of [0.5, 1]) expect(keys.has(poseKey({ ...lookPose(look), lid }))).toBe(true)
    }
  })

  it('lists every step of every glance, blink and flap', () => {
    const keys = new Set(allOwlPoses().map(poseKey))
    for (const from of LOOK_TARGETS) for (const to of LOOK_TARGETS) for (const step of glanceSteps(from, to)) expect(keys.has(poseKey(step.pose))).toBe(true)
    for (const look of LOOK_TARGETS) for (const double of [false, true]) for (const step of blinkSteps(look, double).steps) expect(keys.has(poseKey(step.pose))).toBe(true)
    for (const sequence of Object.values(FLAP_SEQUENCES)) for (const step of sequence) expect(keys.has(poseKey(step.pose))).toBe(true)
  })

  it('draws the look choices from the look targets, sideways ones twice', () => {
    const targets = new Set(LOOK_TARGETS.map(look => look.join(',')))
    for (const look of LOOK_CHOICES) expect(targets.has(look.join(','))).toBe(true)
    expect(LOOK_CHOICES.filter(look => look[0] === -1 && look[1] === 0)).toHaveLength(2)
    expect(LOOK_CHOICES.filter(look => look[0] === 1 && look[1] === 0)).toHaveLength(2)
  })

  it('goes through a flared half-step on a far glance and straight there on a near one', () => {
    const far = glanceSteps([-1, 0], [1, 0])
    expect(far).toHaveLength(2)
    expect(far[0]).toMatchObject({ afterMs: 0, pose: { glow: 2, lx: 0 } })
    expect(far[1]).toMatchObject({ afterMs: OWL_FRAME_MS, pose: { glow: 1, lx: 1 } })
    const near = glanceSteps([0, 0], [0, -1])
    expect(near).toHaveLength(1)
    expect(near[0]).toMatchObject({ afterMs: 0, pose: { glow: 1, ly: -1 } })
  })

  it('blinks half, shut, half, open, once or twice with a rest between', () => {
    const single = blinkSteps([0, 0], false)
    expect(single.steps.map(step => step.pose.lid)).toEqual([0.5, 1, 0.5, 0])
    expect(single.steps.map(step => step.afterMs)).toEqual([0, 80, 160, 240])
    expect(single.lengthMs).toBe(320)
    const double = blinkSteps([1, 0], true)
    expect(double.steps.map(step => step.pose.lid)).toEqual([0.5, 1, 0.5, 0, 0.5, 1, 0.5, 0])
    expect(double.steps[4]!.afterMs).toBe(400)
    expect(double.lengthMs).toBe(720)
  })

  it('gives a blur copy only to a stroke of 34 degrees or more that does not fold a wing', () => {
    for (const sequence of Object.values(FLAP_SEQUENCES)) {
      let previous = -100
      for (const { pose } of sequence) {
        const delta = pose.th - previous
        if (pose.sm !== 0) {
          expect(Math.abs(delta)).toBeGreaterThanOrEqual(34)
          expect(pose.th).toBeGreaterThan(-45)
          expect(pose.sm).toBe(Math.round(-delta / 2))
        }
        previous = pose.th
      }
    }
  })

  it('holds the three flaps to 9 to 13 steps that stay inside the owl box', () => {
    expect(Object.keys(FLAP_SEQUENCES).sort()).toEqual(['flap', 'flutter', 'stretch'])
    for (const sequence of Object.values(FLAP_SEQUENCES)) {
      expect(sequence.length).toBeGreaterThanOrEqual(9)
      expect(sequence.length).toBeLessThanOrEqual(13)
      for (const step of sequence) {
        expect(step.ms).toBeGreaterThanOrEqual(OWL_FRAME_MS)
        expect(step.pose.r).toBeLessThanOrEqual(8.2)
        expect(step.pose.th).toBeGreaterThanOrEqual(-106)
        expect(step.pose.th).toBeLessThanOrEqual(60)
      }
    }
  })

  it('knows no frame for a pose the schedule cannot show', () => {
    expect(owlFrameIndex({ ...REST_POSE, lx: 0.3 })).toBe(-1)
  })

  it('freezes the table so nothing edits a pose another frame shares', () => {
    expect(Object.isFrozen(REST_POSE)).toBe(true)
    expect(Object.isFrozen(allOwlPoses())).toBe(true)
    expect(allOwlPoses().every(pose => Object.isFrozen(pose))).toBe(true)
    expect(Object.isFrozen(FLAP_SEQUENCES.flap)).toBe(true)
  })
})
