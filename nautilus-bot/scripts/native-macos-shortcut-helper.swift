import CoreFoundation
import CoreGraphics
import Foundation

// Plainsong's native macOS shortcut helper.
//
// Electron's globalShortcut only reports key presses, so hold-to-talk needs a
// CGEventTap that sees releases too. This helper watches for a table of
// bindings handed over as JSON on argv (`--bindings '[...]'`) and prints one
// JSON line per transition on stdout:
//
//   {"event":"down","bindingId":"primary"}
//   {"event":"up","bindingId":"primary"}
//
// Three trigger kinds are understood:
//   {"id":"primary","kind":"key","accelerator":"Cmd+Shift+Space"}
//   {"id":"b2","kind":"mouse","button":4,"modifiers":["Cmd"]}   // buttons 3-5
//   {"id":"b3","kind":"modifier","modifier":"Fn"}                // a modifier alone
//
// Escape pressed on its own is always reported as {"event":"down",
// "bindingId":"escape"}; it is the cancel gesture and needs no binding.
//
// `--shortcut Cmd+Shift+Space` is still accepted and means a one-entry key
// table with id "primary".

struct KeyChord {
  let keyCode: CGKeyCode
  let flags: CGEventFlags
}

enum Trigger {
  case key(KeyChord)
  // `button` is the CGEvent button number: 2 = middle, 3 = back, 4 = forward.
  case mouse(button: Int64, flags: CGEventFlags)
  case modifier(CGEventFlags)
}

struct Binding {
  let id: String
  let trigger: Trigger
}

let keyCodes: [String: CGKeyCode] = [
  "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7,
  "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15,
  "Y": 16, "T": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
  "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
  "]": 30, "O": 31, "U": 32, "[": 33, "I": 34, "P": 35, "L": 37,
  "J": 38, "'": 39, "K": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
  "N": 45, "M": 46, ".": 47, "`": 50, "SPACE": 49, "ESCAPE": 53,
  "RETURN": 36, "ENTER": 36, "TAB": 48, "DELETE": 51,
  "LEFT": 123, "RIGHT": 124, "DOWN": 125, "UP": 126,
  "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97,
  "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111
]

let relevantFlags: CGEventFlags = [
  .maskCommand,
  .maskControl,
  .maskAlternate,
  .maskShift,
  .maskSecondaryFn
]

// A modifier pressed on its own is reported only after this long without
// another key joining it, so Cmd+C stays a copy and never a dictation start.
// A modifier released sooner than this is a quick tap and is reported as a
// down immediately followed by an up (which toggle mode treats as a press).
let modifierArmDelay: TimeInterval = 0.15

let escapeBindingId = "escape"

var bindings: [Binding] = []
var downBindingIds = Set<String>()
var pendingModifierArms: [String: DispatchWorkItem] = [:]
var activeEventTap: CFMachPort?

func emit(event: String, bindingId: String) {
  let payload: [String: String] = ["event": event, "bindingId": bindingId]
  guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
    return
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func markDown(_ id: String) {
  if !downBindingIds.contains(id) {
    downBindingIds.insert(id)
    emit(event: "down", bindingId: id)
  }
}

func markUp(_ id: String) {
  if downBindingIds.contains(id) {
    downBindingIds.remove(id)
    emit(event: "up", bindingId: id)
  }
}

func modifierFlag(named token: String) -> CGEventFlags? {
  switch token.lowercased() {
  case "cmd", "command", "meta", "super", "⌘":
    return .maskCommand
  case "ctrl", "control", "⌃":
    return .maskControl
  case "alt", "option", "opt", "⌥":
    return .maskAlternate
  case "shift", "⇧":
    return .maskShift
  case "fn", "function":
    return .maskSecondaryFn
  default:
    return nil
  }
}

func splitShortcutTokens(_ value: String) -> [String] {
  return value
    .replacingOccurrences(of: "⌘", with: " Cmd ")
    .replacingOccurrences(of: "⌃", with: " Ctrl ")
    .replacingOccurrences(of: "⌥", with: " Alt ")
    .replacingOccurrences(of: "⇧", with: " Shift ")
    .split(whereSeparator: { $0 == "+" || $0.isWhitespace })
    .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
}

func parseKeyChord(_ value: String) -> KeyChord? {
  let parts = splitShortcutTokens(value)
  guard let keyPart = parts.last else {
    return nil
  }

  let keyToken = keyPart.uppercased() == "SPACEBAR" ? "SPACE" : keyPart.uppercased()
  let normalizedKeyToken: String
  switch keyToken {
  case "ESC":
    normalizedKeyToken = "ESCAPE"
  case "RETURN":
    normalizedKeyToken = "ENTER"
  case "ARROWUP":
    normalizedKeyToken = "UP"
  case "ARROWDOWN":
    normalizedKeyToken = "DOWN"
  case "ARROWLEFT":
    normalizedKeyToken = "LEFT"
  case "ARROWRIGHT":
    normalizedKeyToken = "RIGHT"
  default:
    normalizedKeyToken = keyToken
  }
  guard let keyCode = keyCodes[normalizedKeyToken] else {
    return nil
  }

  var flags = CGEventFlags()
  for token in parts.dropLast() {
    guard let flag = modifierFlag(named: token) else {
      return nil
    }
    flags.insert(flag)
  }

  return KeyChord(keyCode: keyCode, flags: flags)
}

func parseModifierFlags(_ tokens: [String]) -> CGEventFlags? {
  var flags = CGEventFlags()
  for token in tokens {
    guard let flag = modifierFlag(named: token) else {
      return nil
    }
    flags.insert(flag)
  }
  return flags
}

func parseBinding(_ entry: [String: Any]) -> Binding? {
  guard let id = entry["id"] as? String, !id.isEmpty, id != escapeBindingId,
    let kind = entry["kind"] as? String
  else {
    return nil
  }
  switch kind {
  case "key":
    guard let accelerator = entry["accelerator"] as? String,
      let chord = parseKeyChord(accelerator)
    else {
      return nil
    }
    return Binding(id: id, trigger: .key(chord))
  case "mouse":
    guard let button = entry["button"] as? Int, (3...5).contains(button) else {
      return nil
    }
    let modifierTokens = entry["modifiers"] as? [String] ?? []
    guard let flags = parseModifierFlags(modifierTokens) else {
      return nil
    }
    // Plainsong numbers buttons 3-5 the way browsers and mice do; CGEvent
    // numbers the same physical buttons 2-4.
    return Binding(id: id, trigger: .mouse(button: Int64(button - 1), flags: flags))
  case "modifier":
    guard let modifier = entry["modifier"] as? String,
      let flag = modifierFlag(named: modifier)
    else {
      return nil
    }
    return Binding(id: id, trigger: .modifier(flag))
  default:
    return nil
  }
}

func parseBindingTable(_ json: String) -> [Binding]? {
  guard let data = json.data(using: .utf8),
    let parsed = try? JSONSerialization.jsonObject(with: data),
    let entries = parsed as? [[String: Any]]
  else {
    return nil
  }
  var result: [Binding] = []
  for entry in entries {
    if let binding = parseBinding(entry) {
      result.append(binding)
    } else {
      fputs("Skipping an unreadable binding entry: \(entry)\n", stderr)
    }
  }
  return result
}

func eventFlags(_ event: CGEvent, requiresFn: Bool) -> CGEventFlags {
  var flags = event.flags.intersection(relevantFlags)
  // Arrow, Home/End/PageUp, and fn-row keys always carry the SecondaryFn flag
  // on Apple keyboards. Ignore it unless the binding explicitly requires the
  // fn modifier, so e.g. Cmd+Shift+Up can still match.
  if !requiresFn {
    flags.remove(.maskSecondaryFn)
  }
  return flags
}

func chordMatches(event: CGEvent, chord: KeyChord) -> Bool {
  let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
  if keyCode != chord.keyCode {
    return false
  }
  return eventFlags(event, requiresFn: chord.flags.contains(.maskSecondaryFn)) == chord.flags
}

func cancelPendingModifierArm(_ id: String) {
  if let pending = pendingModifierArms.removeValue(forKey: id) {
    pending.cancel()
  }
}

func releaseEverything() {
  for (_, pending) in pendingModifierArms {
    pending.cancel()
  }
  pendingModifierArms.removeAll()
  for id in Array(downBindingIds) {
    markUp(id)
  }
}

func handleKeyDown(_ event: CGEvent) {
  let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
  let autorepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0

  if keyCode == keyCodes["ESCAPE"]
    && event.flags.intersection(relevantFlags).isEmpty
    && !autorepeat {
    emit(event: "down", bindingId: escapeBindingId)
  }

  for binding in bindings {
    switch binding.trigger {
    case .key(let chord):
      if chordMatches(event: event, chord: chord) {
        markDown(binding.id)
      }
    case .modifier:
      // A key joined the held modifier: it is a chord such as Cmd+C, not a
      // lone-modifier press. Drop the pending arm; a hold already reported
      // stays a hold until the modifier is released.
      cancelPendingModifierArm(binding.id)
    case .mouse:
      break
    }
  }
}

func handleKeyUp(_ event: CGEvent) {
  let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
  for binding in bindings {
    if case .key(let chord) = binding.trigger, chord.keyCode == keyCode {
      markUp(binding.id)
    }
  }
}

func handleFlagsChanged(_ event: CGEvent) {
  let current = event.flags.intersection(relevantFlags)
  for binding in bindings {
    guard case .modifier(let flag) = binding.trigger else {
      continue
    }
    let heldAlone = current == flag
    let released = !current.contains(flag)
    if heldAlone {
      if downBindingIds.contains(binding.id) || pendingModifierArms[binding.id] != nil {
        continue
      }
      let id = binding.id
      let arm = DispatchWorkItem {
        pendingModifierArms.removeValue(forKey: id)
        markDown(id)
      }
      pendingModifierArms[id] = arm
      DispatchQueue.main.asyncAfter(deadline: .now() + modifierArmDelay, execute: arm)
    } else if released {
      if pendingModifierArms[binding.id] != nil {
        // Released before the arm fired: a quick tap. Report it as a
        // press-and-release so toggle mode still starts and stops on it.
        cancelPendingModifierArm(binding.id)
        markDown(binding.id)
        markUp(binding.id)
      } else {
        markUp(binding.id)
      }
    } else {
      // Another modifier joined: a chord, not a lone press.
      cancelPendingModifierArm(binding.id)
    }
  }
}

func handleMouse(_ event: CGEvent, down: Bool) {
  let button = event.getIntegerValueField(.mouseEventButtonNumber)
  for binding in bindings {
    guard case .mouse(let boundButton, let flags) = binding.trigger, boundButton == button else {
      continue
    }
    if down {
      if eventFlags(event, requiresFn: flags.contains(.maskSecondaryFn)) == flags {
        markDown(binding.id)
      }
    } else {
      markUp(binding.id)
    }
  }
}

func callback(
  proxy: CGEventTapProxy,
  type: CGEventType,
  event: CGEvent,
  refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
  // macOS disables the tap (and stops delivering events) after a timeout or
  // on user input under load, e.g. across sleep/wake. Re-enable it so the
  // hotkey does not silently die while this helper process stays alive.
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    // Any release during the outage was lost; let go of every hold so a
    // hold-to-talk recording does not run forever.
    releaseEverything()
    if let tap = activeEventTap {
      CGEvent.tapEnable(tap: tap, enable: true)
      fputs("Event tap was disabled by macOS; re-enabled.\n", stderr)
    }
    return Unmanaged.passUnretained(event)
  }

  switch type {
  case .keyDown:
    handleKeyDown(event)
  case .keyUp:
    handleKeyUp(event)
  case .flagsChanged:
    handleFlagsChanged(event)
  case .otherMouseDown:
    handleMouse(event, down: true)
  case .otherMouseUp:
    handleMouse(event, down: false)
  default:
    break
  }

  return Unmanaged.passUnretained(event)
}

func argumentValue(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else {
    return nil
  }
  return args[index + 1]
}

if let table = argumentValue("--bindings") {
  guard let parsed = parseBindingTable(table) else {
    fputs("Invalid --bindings table: \(table)\n", stderr)
    exit(1)
  }
  bindings = parsed
} else {
  let shortcutValue = argumentValue("--shortcut") ?? "Cmd+Shift+Space"
  guard let chord = parseKeyChord(shortcutValue) else {
    fputs("Invalid shortcut: \(shortcutValue)\n", stderr)
    exit(1)
  }
  bindings = [Binding(id: "primary", trigger: .key(chord))]
}

if bindings.isEmpty {
  fputs("No usable bindings; nothing to watch for.\n", stderr)
  exit(1)
}

// tapDisabledByTimeout/tapDisabledByUserInput are delivered to the callback
// regardless of this mask, so it only needs the input events. flagsChanged
// and the extra mouse buttons are only consulted when a binding needs them,
// but the mask is fixed at tap creation, so it always includes them.
let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
  | CGEventMask(1 << CGEventType.keyUp.rawValue)
  | CGEventMask(1 << CGEventType.flagsChanged.rawValue)
  | CGEventMask(1 << CGEventType.otherMouseDown.rawValue)
  | CGEventMask(1 << CGEventType.otherMouseUp.rawValue)

guard let eventTap = CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .listenOnly,
  eventsOfInterest: mask,
  callback: callback,
  userInfo: nil
) else {
  fputs("Unable to create keyboard event tap. Grant Accessibility or Input Monitoring permission.\n", stderr)
  exit(2)
}

activeEventTap = eventTap
let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: eventTap, enable: true)
CFRunLoopRun()
