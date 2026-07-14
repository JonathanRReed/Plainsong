import CoreFoundation
import CoreGraphics
import Foundation

struct Shortcut {
  let keyCode: CGKeyCode
  let keyLabel: String
  let flags: CGEventFlags
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

var configuredShortcut: Shortcut?
var shortcutIsDown = false
var activeEventTap: CFMachPort?

func emit(type: String, key: String) {
  let payload: [String: String] = ["type": type, "key": key]
  guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
    return
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func parseShortcut(_ value: String) -> Shortcut? {
  let parts = value
    .replacingOccurrences(of: "⌘", with: " Cmd ")
    .replacingOccurrences(of: "⌃", with: " Ctrl ")
    .replacingOccurrences(of: "⌥", with: " Alt ")
    .replacingOccurrences(of: "⇧", with: " Shift ")
    .split(whereSeparator: { $0 == "+" || $0.isWhitespace })
    .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }

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
  for token in parts.dropLast().map({ $0.lowercased() }) {
    switch token {
    case "cmd", "command", "meta", "super":
      flags.insert(.maskCommand)
    case "ctrl", "control":
      flags.insert(.maskControl)
    case "alt", "option":
      flags.insert(.maskAlternate)
    case "shift":
      flags.insert(.maskShift)
    case "fn", "function":
      flags.insert(.maskSecondaryFn)
    default:
      return nil
    }
  }

  return Shortcut(
    keyCode: keyCode,
    keyLabel: normalizedKeyToken == "SPACE" ? "Space" : normalizedKeyToken,
    flags: flags
  )
}

func shortcutMatches(event: CGEvent, shortcut: Shortcut) -> Bool {
  let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
  if keyCode != shortcut.keyCode {
    return false
  }
  var eventFlags = event.flags.intersection(relevantFlags)
  // Arrow, Home/End/PageUp, and fn-row keys always carry the SecondaryFn flag
  // on Apple keyboards. Ignore it unless the configured shortcut explicitly
  // requires the fn modifier, so e.g. Cmd+Shift+Up can still match.
  if !shortcut.flags.contains(.maskSecondaryFn) {
    eventFlags.remove(.maskSecondaryFn)
  }
  return eventFlags == shortcut.flags
}

func callback(
  proxy: CGEventTapProxy,
  type: CGEventType,
  event: CGEvent,
  refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
  // macOS disables the tap (and stops delivering key events) after a timeout
  // or on user input under load, e.g. across sleep/wake. Re-enable it so the
  // hotkey does not silently die while this helper process stays alive.
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if shortcutIsDown {
      // Any key-up during the outage was lost; release the hold so a
      // hold-to-talk recording does not run forever.
      shortcutIsDown = false
      if let shortcut = configuredShortcut {
        emit(type: "up", key: shortcut.keyLabel)
      }
    }
    if let tap = activeEventTap {
      CGEvent.tapEnable(tap: tap, enable: true)
      fputs("Event tap was disabled by macOS; re-enabled.\n", stderr)
    }
    return Unmanaged.passUnretained(event)
  }

  guard let shortcut = configuredShortcut else {
    return Unmanaged.passUnretained(event)
  }

  let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
  if type == .keyDown && keyCode == keyCodes["ESCAPE"]
    && event.flags.intersection(relevantFlags).isEmpty
    && event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
    emit(type: "down", key: "Escape")
    return Unmanaged.passUnretained(event)
  }

  if type == .keyDown && shortcutMatches(event: event, shortcut: shortcut) {
    if !shortcutIsDown {
      shortcutIsDown = true
      emit(type: "down", key: shortcut.keyLabel)
    }
    return Unmanaged.passUnretained(event)
  }

  if type == .keyUp && keyCode == shortcut.keyCode && shortcutIsDown {
    shortcutIsDown = false
    emit(type: "up", key: shortcut.keyLabel)
    return Unmanaged.passUnretained(event)
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

let shortcutValue = argumentValue("--shortcut") ?? "Cmd+Shift+Space"
guard let parsedShortcut = parseShortcut(shortcutValue) else {
  fputs("Invalid shortcut: \(shortcutValue)\n", stderr)
  exit(1)
}
configuredShortcut = parsedShortcut

// tapDisabledByTimeout/tapDisabledByUserInput are delivered to the callback
// regardless of this mask, so it only needs the key events.
let mask = CGEventMask(1 << CGEventType.keyDown.rawValue) |
  CGEventMask(1 << CGEventType.keyUp.rawValue)

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
