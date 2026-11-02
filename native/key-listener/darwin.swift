// Sotto's macOS key listener: a listen-only event tap that reports modifier
// transitions and shortcut keys to main as lines on stdout (ADR-0097).
import Carbon.HIToolbox
import CoreGraphics
import Foundation

let keyTokens: [Int64: String] = [
  0x00: "A", 0x0B: "B", 0x08: "C", 0x02: "D", 0x0E: "E", 0x03: "F", 0x05: "G", 0x04: "H", 0x22: "I",
  0x26: "J", 0x28: "K", 0x25: "L", 0x2E: "M", 0x2D: "N", 0x1F: "O", 0x23: "P", 0x0C: "Q", 0x0F: "R",
  0x01: "S", 0x11: "T", 0x20: "U", 0x09: "V", 0x0D: "W", 0x07: "X", 0x10: "Y", 0x06: "Z",
  0x1D: "0", 0x12: "1", 0x13: "2", 0x14: "3", 0x15: "4", 0x17: "5", 0x16: "6", 0x1A: "7", 0x1C: "8", 0x19: "9",
  0x7A: "F1", 0x78: "F2", 0x63: "F3", 0x76: "F4", 0x60: "F5", 0x61: "F6", 0x62: "F7", 0x64: "F8", 0x65: "F9",
  0x6D: "F10", 0x67: "F11", 0x6F: "F12", 0x69: "F13", 0x6B: "F14", 0x71: "F15", 0x6A: "F16", 0x40: "F17",
  0x4F: "F18", 0x50: "F19", 0x5A: "F20",
  0x31: "Space", 0x24: "Enter", 0x30: "Tab", 0x33: "Backspace", 0x75: "Delete",
  0x7E: "Up", 0x7D: "Down", 0x7B: "Left", 0x7C: "Right",
  0x73: "Home", 0x77: "End", 0x74: "PageUp", 0x79: "PageDown", 0x35: "Escape",
]

// flagsChanged keycode -> token and the device-dependent (left/right) flag bit that says it is down.
let modifierKeys: [Int64: (token: String, mask: UInt64)] = [
  0x3B: ("Control", 0x0001), 0x3E: ("Control", 0x2000),
  0x3A: ("Alt", 0x0020), 0x3D: ("Alt", 0x0040),
  0x38: ("Shift", 0x0002), 0x3C: ("Shift", 0x0004),
  0x37: ("CommandOrControl", 0x0008), 0x36: ("CommandOrControl", 0x0010),
  0x3F: ("Fn", CGEventFlags.maskSecondaryFn.rawValue),
]

// Device-independent mask and both device bits per non-Fn class, for events (remappers, virtual keyboards) without device bits.
let modifierClasses: [String: (mask: UInt64, device: UInt64)] = [
  "Control": (CGEventFlags.maskControl.rawValue, 0x2001),
  "Alt": (CGEventFlags.maskAlternate.rawValue, 0x0060),
  "Shift": (CGEventFlags.maskShift.rawValue, 0x0006),
  "CommandOrControl": (CGEventFlags.maskCommand.rawValue, 0x0018),
]

let hidSystemState = Int64(CGEventSourceStateID.hidSystemState.rawValue)
let arguments = CommandLine.arguments
let acceptSynthetic = arguments.contains("--accept-synthetic")

// All state below is touched only on the main thread.
var watched = Set<String>()
var recording = false
var modifiersDown = Set<Int64>()          // physical modifier keycodes
var keysDown = [Int64: String?]()         // physical key -> reported token, nil when its down was suppressed
var reportedCount = [String: Int]()       // token -> physical keys whose down was reported
// The poll's queries, injectable for --selftest. hidKeyDown(0x3F) asks for Fn.
var hidKeyDown: (Int64) -> Bool = { code in
  code == 0x3F
    ? CGEventSource.flagsState(.hidSystemState).contains(.maskSecondaryFn)
    : CGEventSource.keyState(.hidSystemState, key: CGKeyCode(code))
}
var sessionFlags: () -> UInt64 = { CGEventSource.flagsState(.combinedSessionState).rawValue }
var secureInput: () -> Bool = { IsSecureEventInputEnabled() }
var readUpOnce = Set<Int64>()             // tracked keys the previous poll read as up
var emit: (String) -> Void = { line in
  print(line)
  fflush(stdout)
}

func report(_ token: String, down: Bool) {
  let count = reportedCount[token, default: 0] + (down ? 1 : -1)
  reportedCount[token] = count > 0 ? count : nil
  if (down && count == 1) || (!down && count == 0) { emit("\(down ? "down" : "up") \(token)") }
}

func resetState() {
  modifiersDown.removeAll()
  keysDown.removeAll()
  reportedCount.removeAll()
  readUpOnce.removeAll()
}

// A modifier also counts as held while the session flags carry its class (a Sticky Keys latch).
func isHeld(_ code: Int64) -> Bool {
  if hidKeyDown(code) { return true }
  guard let token = modifierKeys[code]?.token else { return false }
  let mask = token == "Fn" ? CGEventFlags.maskSecondaryFn.rawValue : modifierClasses[token]?.mask ?? 0
  return sessionFlags() & mask != 0
}

// Recording starts by naming every modifier already down, whose own event predates
// the tap: Fn held while clicking Record, or pressed before the helper was ready.
// One named again on the next recording is a duplicate main tolerates: a cancel
// made it forget the first down while the key is still held.
func seedHeldModifiers() {
  for code in modifierKeys.keys.sorted() where isHeld(code) {
    guard let modifier = modifierKeys[code] else { continue }
    if modifiersDown.insert(code).inserted { report(modifier.token, down: true) }
    else { emit("down \(modifier.token)") }
  }
}

// The 0.5 s poll, run only between events so it never reorders them. Some ups never arrive
// (lock screen, sleep): a tracked key read up by two polls in a row is released.
func reconcile() {
  // Secure input withholds key state from other processes.
  if secureInput() { readUpOnce.removeAll(); return }
  var upNow = Set<Int64>()
  for code in modifiersDown where !isHeld(code) {
    if !readUpOnce.contains(code) { upNow.insert(code); continue }
    modifiersDown.remove(code)
    if let modifier = modifierKeys[code] { report(modifier.token, down: false) }
  }
  for (code, token) in keysDown where !isHeld(code) {
    if !readUpOnce.contains(code) { upNow.insert(code); continue }
    keysDown.removeValue(forKey: code)
    if let token = token { report(token, down: false) }
  }
  readUpOnce = upNow
}

func handle(type: CGEventType, event: CGEvent) {
  if !acceptSynthetic && (event.getIntegerValueField(.eventSourceStateID) != hidSystemState
    || event.getIntegerValueField(.eventSourceUnixProcessID) != 0) { return }
  let code = event.getIntegerValueField(.keyboardEventKeycode)
  switch type {
  case .flagsChanged:
    // Fn's direction comes only from this event's own flags (keyDown/keyUp of arrows carry maskSecondaryFn too).
    guard let modifier = modifierKeys[code] else { return }
    let flags = event.flags.rawValue
    if let group = modifierClasses[modifier.token], flags & group.device == 0 {
      if flags & group.mask != 0 {
        if modifiersDown.insert(code).inserted { report(modifier.token, down: true) }
      } else {
        for held in modifiersDown where modifierKeys[held]?.token == modifier.token {
          modifiersDown.remove(held)
          report(modifier.token, down: false)
        }
      }
      return
    }
    let down = flags & modifier.mask != 0
    if down == modifiersDown.contains(code) { return }
    if down { modifiersDown.insert(code) } else { modifiersDown.remove(code) }
    report(modifier.token, down: down)
  case .keyDown:
    if keysDown[code] != nil { return }
    let known = keyTokens[code]
    var token: String? = nil
    if recording {
      token = known ?? "Other"
    } else if let key = known, key.hasPrefix("F"), key.count > 1, watched.contains(key) {
      token = key
    } else if !modifiersDown.isEmpty {
      token = known.flatMap { watched.contains($0) ? $0 : nil } ?? "Other"
    }
    keysDown[code] = .some(token)
    if let token = token { report(token, down: true) }
  case .keyUp:
    guard let entry = keysDown.removeValue(forKey: code) else { return }
    if let token = entry { report(token, down: false) }
  default:
    return
  }
}

func command(_ raw: String) {
  let parts = raw.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " ").map(String.init)
  switch parts.first {
  case "keys": watched = Set(parts.dropFirst())
  case "record":
    if parts.count == 2 {
      recording = parts[1] == "on"
      if recording { seedHeldModifiers() }
    }
  case "request": _ = CGRequestListenEventAccess()
  default: break
  }
}

// MARK: - Self-test

func selftest() -> Int32 {
  var lines: [String] = []
  emit = { lines.append($0) }
  var lost = Set<Int64>(), sticky: UInt64 = 0, secure = false
  hidKeyDown = { !lost.contains($0) }
  sessionFlags = { sticky }
  secureInput = { secure }
  func event(_ type: CGEventType, _ code: Int64, _ flags: UInt64 = 0, synthetic: Bool = false, pid: Int64 = 0) -> (CGEventType, CGEvent) {
    let made = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: type == .keyDown)!
    if type == .flagsChanged { made.type = .flagsChanged }
    made.flags = CGEventFlags(rawValue: flags)
    made.setIntegerValueField(.eventSourceStateID, value: synthetic ? 0 : hidSystemState)
    made.setIntegerValueField(.eventSourceUnixProcessID, value: pid)
    return (type, made)
  }
  let poll: (CGEventType, CGEvent)? = nil
  let shift = CGEventFlags.maskShift.rawValue, control = CGEventFlags.maskControl.rawValue
  let fn = CGEventFlags.maskSecondaryFn.rawValue
  // A nil event runs the 500 ms poll; lostKeys lists the keycodes whose up never arrives in a case.
  let cases: [(name: String, keys: [String], record: Bool, events: [(CGEventType, CGEvent)?], expect: [String])] = [
    ("modifier-only chord with left/right refcounting", [], false, [
      event(.flagsChanged, 0x38, shift | 0x2), event(.flagsChanged, 0x3C, shift | 0x6),
      event(.flagsChanged, 0x3B, shift | control | 0x7), event(.flagsChanged, 0x38, shift | control | 0x5),
      event(.flagsChanged, 0x3C, control | 0x1), event(.flagsChanged, 0x3B, 0),
    ], ["down Shift", "down Control", "up Shift", "up Control"]),
    ("watched and Other keys under a modifier", ["Space"], false, [
      event(.flagsChanged, 0x3B, control | 0x1), event(.keyDown, 0x31, control), event(.keyDown, 0x31, control),
      event(.keyDown, 0x00, control), event(.keyUp, 0x31, control), event(.keyUp, 0x00, control), event(.flagsChanged, 0x3B, 0),
    ], ["down Control", "down Space", "down Other", "up Space", "up Other", "up Control"]),
    ("unwatched key with no modifier", ["Space"], false, [
      event(.keyDown, 0x00), event(.keyUp, 0x00), event(.keyDown, 0x31), event(.keyUp, 0x31),
    ], []),
    ("watched F-key alone", ["F5"], false, [
      event(.keyDown, 0x60, fn), event(.keyUp, 0x60, fn), event(.keyDown, 0x61), event(.keyUp, 0x61),
    ], ["down F5", "up F5"]),
    ("record mode reports every key", [], true, [
      event(.keyDown, 0x00), event(.keyDown, 0x52), event(.keyDown, 0x35),
      event(.keyUp, 0x00), event(.keyUp, 0x52), event(.keyUp, 0x35),
    ], ["down A", "down Other", "down Escape", "up A", "up Other", "up Escape"]),
    ("up whose down was not reported is suppressed", ["A"], false, [
      event(.keyDown, 0x00), event(.flagsChanged, 0x3B, control | 0x1), event(.keyUp, 0x00, control), event(.flagsChanged, 0x3B, 0),
    ], ["down Control", "up Control"]),
    ("reported up survives the modifier going first", ["A"], false, [
      event(.flagsChanged, 0x3B, control | 0x1), event(.keyDown, 0x00, control), event(.flagsChanged, 0x3B, 0), event(.keyUp, 0x00),
    ], ["down Control", "down A", "up Control", "up A"]),
    ("Fn down and up from flagsChanged 0x3F", ["Fn"], false, [
      event(.flagsChanged, 0x3F, fn), event(.flagsChanged, 0x3F, 0),
    ], ["down Fn", "up Fn"]),
    ("arrow keyDown carrying maskSecondaryFn is not Fn", ["Up"], false, [
      event(.keyDown, 0x7E, fn), event(.keyUp, 0x7E, fn),
    ], []),
    ("modifier down and up without device bits", [], false, [
      event(.flagsChanged, 0x3A, CGEventFlags.maskAlternate.rawValue), event(.flagsChanged, 0x3A, 0),
    ], ["down Alt", "up Alt"]),
    ("left and right release without device bits", [], false, [
      event(.flagsChanged, 0x37, CGEventFlags.maskCommand.rawValue), event(.flagsChanged, 0x36, CGEventFlags.maskCommand.rawValue),
      event(.flagsChanged, 0x37, CGEventFlags.maskCommand.rawValue), event(.flagsChanged, 0x36, 0),
    ], ["down CommandOrControl", "up CommandOrControl"]),
    ("synthetic events ignored", ["A"], false, [
      event(.flagsChanged, 0x3B, control | 0x1, synthetic: true), event(.keyDown, 0x00, control, synthetic: true),
    ], []),
    ("events posted by a process are synthetic", ["A"], false, [
      event(.flagsChanged, 0x3B, control | 0x1, pid: 4242), event(.keyDown, 0x00, control, pid: 4242),
    ], []),
    ("lost Control up fixed by the poll", ["A"], false, [
      event(.flagsChanged, 0x3B, control | 0x1), poll, poll, event(.keyDown, 0x00), event(.keyUp, 0x00),
    ], ["down Control", "up Control"]),
    ("a held key read up once is not released", ["Space"], false, [
      event(.flagsChanged, 0x3B, control | 0x1), event(.keyDown, 0x31, control), poll, event(.flagsChanged, 0x3B, 0), event(.keyUp, 0x31),
    ], ["down Control", "down Space", "up Control", "up Space"]),
    ("a sticky-latched modifier is not released", ["Space"], false, [
      event(.flagsChanged, 0x3B, control | 0x1), poll, poll, event(.keyDown, 0x31, control),
    ], ["down Control", "down Space"]),
    ("nothing is released while secure input is on", ["Space"], false, [
      event(.flagsChanged, 0x3B, control | 0x1), poll, poll, event(.keyDown, 0x31, control),
    ], ["down Control", "down Space"]),
    ("lost hold-key up corrected by the poll", ["Space"], false, [
      event(.flagsChanged, 0x3B, control | 0x1), event(.keyDown, 0x31, control), poll, poll, event(.flagsChanged, 0x3B, 0),
    ], ["down Control", "down Space", "up Space", "up Control"]),
    ("lost Fn up corrected by the poll", ["Fn"], false, [
      event(.flagsChanged, 0x3F, fn), poll, poll, event(.flagsChanged, 0x3F, 0),
    ], ["down Fn", "up Fn"]),
    ("lost right Shift keeps the refcount", [], false, [
      event(.flagsChanged, 0x38, shift | 0x2), event(.flagsChanged, 0x3C, shift | 0x6), poll, poll, event(.flagsChanged, 0x38, 0),
    ], ["down Shift", "up Shift"]),
  ]
  let lostKeys: [String: Set<Int64>] = [
    "lost Control up fixed by the poll": [0x3B],
    "a held key read up once is not released": [0x31],
    "a sticky-latched modifier is not released": [0x3B],
    "nothing is released while secure input is on": [0x3B],
    "lost hold-key up corrected by the poll": [0x31],
    "lost Fn up corrected by the poll": [0x3F],
    "lost right Shift keeps the refcount": [0x3C],
  ]
  for test in cases {
    resetState()
    lines = []
    watched = Set(test.keys)
    recording = test.record
    lost = lostKeys[test.name] ?? []
    sticky = test.name == "a sticky-latched modifier is not released" ? control : 0
    secure = test.name == "nothing is released while secure input is on"
    for step in test.events {
      if let (type, made) = step { handle(type: type, event: made) } else { reconcile() }
    }
    if lines != test.expect {
      FileHandle.standardError.write("selftest failed: \(test.name): got \(lines), expected \(test.expect)\n".data(using: .utf8)!)
      return 1
    }
  }
  // A modifier already down when recording starts is named at once: its own event
  // predates the tap (Fn held while clicking Record, or pressed before the helper was ready).
  resetState()
  lines = []
  watched = []
  recording = false
  lost = Set(modifierKeys.keys).subtracting([0x3F])  // hidKeyDown reads only Fn as held
  sticky = 0
  secure = false
  command("record on")
  for step in [event(.keyDown, 0x31), event(.keyUp, 0x31), event(.flagsChanged, 0x3F, 0)] {
    handle(type: step.0, event: step.1)
  }
  if lines != ["down Fn", "down Space", "up Space", "up Fn"] {
    FileHandle.standardError.write("selftest failed: record-on seeds a held Fn: got \(lines)\n".data(using: .utf8)!)
    return 1
  }
  // With nothing held, record-on names nothing.
  resetState()
  lines = []
  recording = false
  lost = Set(modifierKeys.keys)
  command("record on")
  if lines != [] {
    FileHandle.standardError.write("selftest failed: record-on seeds nothing unheld: got \(lines)\n".data(using: .utf8)!)
    return 1
  }
  // A held modifier is named again for the next recording: main forgot the first down with the cancel.
  resetState()
  lines = []
  recording = false
  lost = Set(modifierKeys.keys).subtracting([0x3F])
  command("record on")
  command("record off")
  command("record on")
  if lines != ["down Fn", "down Fn"] {
    FileHandle.standardError.write("selftest failed: record-on re-seeds a held Fn: got \(lines)\n".data(using: .utf8)!)
    return 1
  }
  return 0
}

if arguments.contains("--selftest") { exit(selftest()) }

// MARK: - Live

setvbuf(stdout, nil, _IOLBF, 0)

var tap: CFMachPort?

let tapCallback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let tap = tap { CGEvent.tapEnable(tap: tap, enable: true) }
    resetState()
    emit("reset")
  } else {
    handle(type: type, event: event)
  }
  return Unmanaged.passUnretained(event)
}

func installTap() -> Bool {
  let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue)
  guard let created = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                        eventsOfInterest: CGEventMask(mask), callback: tapCallback, userInfo: nil) else { return false }
  tap = created
  CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, created, 0), .commonModes)
  CGEvent.tapEnable(tap: created, enable: true)
  return true
}

func listenGranted() -> Bool {
  guard CGPreflightListenEventAccess() else { return false }
  if let tap = tap {
    CGEvent.tapEnable(tap: tap, enable: true)
    return true
  }
  return installTap()
}

// Input Monitoring can be turned off and on while the helper runs, so the grant is checked every 2 s and each change
// reported: main takes the main shortcut back while it is off.
var granted = listenGranted()
emit(granted ? "permission granted" : "permission denied")
Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
  let now = granted ? CGPreflightListenEventAccess() : listenGranted()
  if now != granted {
    granted = now
    emit(now ? "permission granted" : "permission denied")
  }
}

// The poll shares the main run loop with the tap, so the key state keeps one owner.
Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
  if !modifiersDown.isEmpty || !keysDown.isEmpty { reconcile() }
}

Thread {
  while let line = readLine(strippingNewline: true) {
    DispatchQueue.main.async { command(line) }
  }
  DispatchQueue.main.async { exit(0) }
}.start()

CFRunLoopRun()
