// The macOS measurements from outside the spike's processes, as VoiceOver and a user's hands would meet them.
//   macprobe trust                     whether this process may use the Accessibility API (AXIsProcessTrusted)
//   macprobe windows <pid>             the process's on-screen windows: id, bounds, title
//   macprobe ax <pid> [depth]          the process's accessibility tree, after asking Chromium to build its own
//   macprobe click <pid> <x> <y>       a real left click at (x, y) inside the process's first window's content
//   macprobe type <text>               real key presses for each character, to whatever has the keyboard
// Build: swiftc -O macprobe.swift -o macprobe
import ApplicationServices
import Cocoa
import Foundation

func out(_ s: String) { print(s); fflush(stdout) }

func firstWindow(_ pid: pid_t) -> (CGWindowID, CGRect, String)? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for w in list where (w[kCGWindowOwnerPID as String] as? pid_t) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
        let id = w[kCGWindowNumber as String] as? CGWindowID ?? 0
        var rect = CGRect.zero
        if let b = w[kCGWindowBounds as String] { rect = CGRect(dictionaryRepresentation: b as! CFDictionary) ?? .zero }
        return (id, rect, w[kCGWindowName as String] as? String ?? "")
    }
    return nil
}

func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}

let args = CommandLine.arguments
guard args.count >= 2 else { out("usage: macprobe trust|windows|ax|click|type ..."); exit(2) }
switch args[1] {
case "trust":
    out("AXIsProcessTrusted \(AXIsProcessTrusted())")
    out("CGPreflightScreenCaptureAccess \(CGPreflightScreenCaptureAccess())")
    out("CGPreflightPostEventAccess \(CGPreflightPostEventAccess())")
case "windows":
    let pid = pid_t(args[2])!
    if let w = firstWindow(pid) { let (id, rect, title) = w; out("window \(id) x=\(Int(rect.origin.x)) y=\(Int(rect.origin.y)) w=\(Int(rect.width)) h=\(Int(rect.height)) title='\(title)'") }
    else { out("no on-screen window for pid \(pid)") }
case "ax":
    let pid = pid_t(args[2])!
    let maxDepth = args.count > 3 ? Int(args[3])! : 30
    out("AXIsProcessTrusted \(AXIsProcessTrusted())")
    let app = AXUIElementCreateApplication(pid)
    // Chromium builds its accessibility tree for a client that sets one of these on the application element.
    for name in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
        let r = AXUIElementSetAttributeValue(app, name as CFString, kCFBooleanTrue)
        out("set \(name): AXError \(r.rawValue)")
    }
    Thread.sleep(forTimeInterval: 2.5)
    var role: AnyObject?
    out("application role read: AXError \(AXUIElementCopyAttributeValue(app, kAXRoleAttribute as CFString, &role).rawValue)")
    var count = 0
    var roles: [String: Int] = [:]
    func walk(_ e: AXUIElement, _ depth: Int) {
        count += 1
        if count > 3000 { return }
        let role = attr(e, kAXRoleAttribute) as? String ?? "?"
        roles[role, default: 0] += 1
        let title = attr(e, kAXTitleAttribute) as? String ?? ""
        let desc = attr(e, kAXDescriptionAttribute) as? String ?? ""
        var value = ""
        if let v = attr(e, kAXValueAttribute) { value = String("\(v)".prefix(60)) }
        let sub = attr(e, kAXSubroleAttribute) as? String ?? ""
        out(String(repeating: "  ", count: depth) + "\(role)\(sub.isEmpty ? "" : "/" + sub) title='\(title)' desc='\(desc)' value='\(value)'")
        guard depth < maxDepth, let kids = attr(e, kAXChildrenAttribute) as? [AXUIElement] else { return }
        for k in kids { walk(k, depth + 1) }
    }
    walk(app, 0)
    out("elements \(count)")
    out("roles \(roles.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))")
case "click":
    let pid = pid_t(args[2])!
    guard let w = firstWindow(pid) else { out("no window"); exit(1) }
    let rect = w.1
    // The window's bounds include the title bar; content starts below it.
    let titleBar = 28.0
    let p = CGPoint(x: rect.origin.x + Double(args[3])!, y: rect.origin.y + titleBar + Double(args[4])!)
    let src = CGEventSource(stateID: .hidSystemState)
    for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.08)
    }
    out("clicked at screen \(Int(p.x)),\(Int(p.y))")
case "type":
    let src = CGEventSource(stateID: .hidSystemState)
    for ch in args[2].utf16 {
        var c = ch
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
            e?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &c)
            e?.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.03)
        }
    }
    out("typed \(args[2].count) characters")
default:
    out("unknown command \(args[1])"); exit(2)
}
