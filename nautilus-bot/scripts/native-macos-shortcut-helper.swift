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
  case modifier(ModifierKey)
}

struct ModifierKey {
  let flag: CGEventFlags
  let keyCode: CGKeyCode
  let deviceMask: UInt64
  let oppositeMask: UInt64

  func isDown(_ event: CGEvent) -> Bool {
    event.flags.rawValue & deviceMask != 0
  }

  func isAlone(_ event: CGEvent) -> Bool {
    isDown(event) && event.flags.rawValue & oppositeMask == 0
      && event.flags.intersection(relevantFlags) == flag
  }
}

func loneModifier(named token: String) -> ModifierKey? {
  switch token.lowercased() {
  case "fn", "function":
    return ModifierKey(flag: .maskSecondaryFn, keyCode: 63,
      deviceMask: CGEventFlags.maskSecondaryFn.rawValue, oppositeMask: 0)
  case "rightcommand":
    return ModifierKey(flag: .maskCommand, keyCode: 54, deviceMask: 0x10, oppositeMask: 0x08)
  case "rightoption":
    return ModifierKey(flag: .maskAlternate, keyCode: 61, deviceMask: 0x40, oppositeMask: 0x20)
  default:
    return nil
  }
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

var dictationSessionActive = false

func handleControlLine(_ line: String) {
  // Nothing drains autorelease pools on a bare CFRunLoopRun main thread, so
  // every path that touches Foundation objects brings its own.
  autoreleasepool {
    guard let data = line.data(using: .utf8),
      let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let active = payload["sessionActive"] as? Bool else { return }
    dictationSessionActive = active
  }
}

var bindings: [Binding] = []
var downBindingIds = Set<String>()
var pendingModifierArms: [String: DispatchWorkItem] = [:]
var activeEventTap: CFMachPort?
var heldKeys = Set<CGKeyCode>()
var heldMouseButtons = Set<Int64>()
let eventEpochOffsetMs = Date().timeIntervalSince1970 * 1000 - Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
var occurrenceEpochMs = Date().timeIntervalSince1970 * 1000
var selfTestPayloads: [[String: Any]] = []

func observeOccurrence(_ event: CGEvent) {
  occurrenceEpochMs = eventEpochOffsetMs + Double(event.timestamp) / 1_000_000
}
var blockedModifiers = Set<String>()
var modifierArmGeneration: [String: Int] = [:]
var selfTestEvents: [String]?
var modifierPressEpochMs: [String: Double] = [:]

func emit(event: String, bindingId: String) {
  var payload: [String: Any] = ["event": event, "bindingId": bindingId,
    "occurrenceEpochMs": event == "down" ? modifierPressEpochMs[bindingId] ?? occurrenceEpochMs : occurrenceEpochMs]
  if let pressedAt = modifierPressEpochMs[bindingId] {
    payload["modifierArmDelayMs"] = modifierArmDelay * 1000
    if event == "down" { payload["pressEpochMs"] = pressedAt }
  }
  if selfTestEvents != nil {
    selfTestEvents?.append("\(event):\(bindingId)")
    selfTestPayloads.append(payload)
    return
  }
  autoreleasepool {
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
      return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  }
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
      let flag = loneModifier(named: modifier)
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
  modifierArmGeneration[id, default: 0] += 1
  if let pending = pendingModifierArms.removeValue(forKey: id) {
    pending.cancel()
  }
}

func cancelModifier(_ id: String, pendingGesture: Bool = false) {
  let pending = pendingModifierArms[id] != nil
  cancelPendingModifierArm(id)
  if downBindingIds.remove(id) != nil || pending || pendingGesture {
    blockedModifiers.insert(id)
    emit(event: "cancel", bindingId: id)
  }
}

func releaseEverything() {
  for binding in bindings {
    cancelPendingModifierArm(binding.id)
    emit(event: "cancel", bindingId: binding.id)
  }
  downBindingIds.removeAll()
  blockedModifiers.removeAll()
  modifierPressEpochMs.removeAll()
  heldKeys.removeAll()
  heldMouseButtons.removeAll()
}

func handleKeyDown(_ event: CGEvent) {
  observeOccurrence(event)
  let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
  let autorepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
  heldKeys.insert(keyCode)

  if keyCode == keyCodes["ESCAPE"]
    && (dictationSessionActive || event.flags.intersection(relevantFlags).isEmpty)
    && !autorepeat {
    emit(event: "down", bindingId: escapeBindingId)
    return
  }

  for binding in bindings {
    switch binding.trigger {
    case .key(let chord):
      if chordMatches(event: event, chord: chord) {
        markDown(binding.id)
      }
    case .modifier:
      cancelModifier(binding.id)
    case .mouse:
      break
    }
  }
}

func handleKeyUp(_ event: CGEvent) {
  observeOccurrence(event)
  let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
  heldKeys.remove(keyCode)
  for binding in bindings {
    if case .key(let chord) = binding.trigger, chord.keyCode == keyCode {
      markUp(binding.id)
    }
  }
}

func handleFlagsChanged(_ event: CGEvent) {
  observeOccurrence(event)
  let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
  for binding in bindings {
    guard case .modifier(let modifier) = binding.trigger else { continue }
    if !modifier.isDown(event) {
      if keyCode == modifier.keyCode {
        if pendingModifierArms[binding.id] != nil && !blockedModifiers.contains(binding.id) {
          cancelPendingModifierArm(binding.id)
          markDown(binding.id)
          markUp(binding.id)
        } else {
          markUp(binding.id)
        }
        blockedModifiers.remove(binding.id)
        modifierPressEpochMs.removeValue(forKey: binding.id)
      }
      continue
    }
    let ordinaryKeyHeld = !heldKeys.isEmpty || (selfTestEvents == nil &&
      keyCodes.values.contains { CGEventSource.keyState(.combinedSessionState, key: $0) })
    let mouseHeld = !heldMouseButtons.isEmpty || (selfTestEvents == nil &&
      (0...31).contains { CGEventSource.buttonState(.combinedSessionState, button: CGMouseButton(rawValue: UInt32($0))!) })
    if !modifier.isAlone(event) || ordinaryKeyHeld || mouseHeld {
      cancelModifier(binding.id, pendingGesture: keyCode == modifier.keyCode && !blockedModifiers.contains(binding.id))
      continue
    }
    guard keyCode == modifier.keyCode, !blockedModifiers.contains(binding.id),
      !downBindingIds.contains(binding.id), pendingModifierArms[binding.id] == nil else { continue }
    let id = binding.id
    modifierPressEpochMs[id] = occurrenceEpochMs
    let generation = modifierArmGeneration[id, default: 0]
    let arm = DispatchWorkItem {
      guard modifierArmGeneration[id, default: 0] == generation,
        pendingModifierArms[id] != nil, !blockedModifiers.contains(id) else { return }
      pendingModifierArms.removeValue(forKey: id)
      markDown(id)
    }
    pendingModifierArms[id] = arm
    DispatchQueue.main.asyncAfter(deadline: .now() + modifierArmDelay, execute: arm)
  }
}

func handleMouse(_ event: CGEvent, down: Bool) {
  observeOccurrence(event)
  let button = event.getIntegerValueField(.mouseEventButtonNumber)
  if down { heldMouseButtons.insert(button) } else { heldMouseButtons.remove(button) }
  if down {
    for binding in bindings {
      if case .modifier = binding.trigger { cancelModifier(binding.id) }
    }
  }
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
  autoreleasepool {
    // macOS disables the tap (and stops delivering events) after a timeout or
    // on user input under load, e.g. across sleep/wake. Re-enable it so the
    // hotkey does not silently die while this helper process stays alive.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      // Any release during the outage was lost; let go of every hold so a
      // hold-to-talk recording does not run forever.
      observeOccurrence(event)
      releaseEverything()
      if let tap = activeEventTap {
        CGEvent.tapEnable(tap: tap, enable: true)
        fputs("Event tap was disabled by macOS; re-enabled.\n", stderr)
      }
      return
    }

    switch type {
    case .keyDown:
      handleKeyDown(event)
    case .keyUp:
      handleKeyUp(event)
    case .flagsChanged:
      handleFlagsChanged(event)
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
      handleMouse(event, down: true)
    case .leftMouseUp, .rightMouseUp, .otherMouseUp:
      handleMouse(event, down: false)
    default:
      break
    }
  }

  return Unmanaged.passUnretained(event)
}

func eventBit(_ type: CGEventType) -> CGEventMask {
  CGEventMask(1) << CGEventMask(type.rawValue)
}

/// The input events the tap must see for this binding table. The table is
/// fixed for the helper's lifetime (a change respawns it), so the session-wide
/// tap is never woken for clicks or modifier changes no binding can use.
func eventMask(for table: [Binding]) -> CGEventMask {
  // Key presses always: key chords, the Escape cancel gesture, and the
  // keystrokes that cancel a pending lone modifier.
  var mask = eventBit(.keyDown) | eventBit(.keyUp)
  let watchesModifier = table.contains { if case .modifier = $0.trigger { return true }; return false }
  let watchesMouse = table.contains { if case .mouse = $0.trigger { return true }; return false }
  if watchesModifier {
    // A lone modifier needs its own transitions, and any click joining it
    // cancels it (and a held button blocks it).
    mask |= eventBit(.flagsChanged)
      | eventBit(.leftMouseDown) | eventBit(.leftMouseUp)
      | eventBit(.rightMouseDown) | eventBit(.rightMouseUp)
  }
  if watchesModifier || watchesMouse {
    mask |= eventBit(.otherMouseDown) | eventBit(.otherMouseUp)
  }
  return mask
}

func argumentValue(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else {
    return nil
  }
  return args[index + 1]
}

func runSelfTest() {
  selfTestEvents = []
  func event(_ code: CGKeyCode, _ flags: UInt64) -> CGEvent {
    let value = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)!
    value.flags = CGEventFlags(rawValue: flags)
    return value
  }
  func reset(_ name: String) {
    releaseEverything()
    bindings = [Binding(id: "right", trigger: .modifier(loneModifier(named: name)!))]
    selfTestEvents = []
    selfTestPayloads = []
  }
  let keyOnly = eventMask(for: [Binding(id: "k", trigger: .key(parseKeyChord("Cmd+Shift+Space")!))])
  assert(keyOnly == eventBit(.keyDown) | eventBit(.keyUp), "key-only table woke for clicks or modifiers")
  let mouseOnly = eventMask(for: [Binding(id: "m", trigger: .mouse(button: 3, flags: []))])
  assert(mouseOnly == keyOnly | eventBit(.otherMouseDown) | eventBit(.otherMouseUp), "mouse table mask")
  let withModifier = eventMask(for: [
    Binding(id: "k", trigger: .key(parseKeyChord("Cmd+Shift+Space")!)),
    Binding(id: "r", trigger: .modifier(loneModifier(named: "RightOption")!)),
  ])
  for type in [CGEventType.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp,
    .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp] {
    assert(withModifier & eventBit(type) != 0, "modifier table missed \(type.rawValue)")
  }
  assert(!dictationSessionActive)
  handleControlLine("unknown")
  handleControlLine("{\"other\":true}")
  assert(!dictationSessionActive)
  bindings = [Binding(id: "chord", trigger: .key(parseKeyChord("Cmd+Shift+Space")!))]
  selfTestEvents = []
  let heldFlags = CGEventFlags.maskCommand.rawValue | CGEventFlags.maskShift.rawValue
  handleKeyDown(event(53, heldFlags))
  assert(selfTestEvents == [])
  handleControlLine("{\"sessionActive\":true}")
  handleKeyDown(event(53, heldFlags))
  assert(selfTestEvents == ["down:escape"])
  handleControlLine("{\"sessionActive\":false}")
  handleKeyDown(event(53, heldFlags))
  assert(selfTestEvents == ["down:escape"])
  for (name, code, otherCode, mask, otherMask, flag) in [
    ("RightCommand", CGKeyCode(54), CGKeyCode(55), UInt64(0x10), UInt64(0x08), CGEventFlags.maskCommand.rawValue),
    ("RightOption", CGKeyCode(61), CGKeyCode(58), UInt64(0x40), UInt64(0x20), CGEventFlags.maskAlternate.rawValue)
  ] {
    reset(name)
    handleKeyDown(event(8, 0))
    handleKeyUp(event(8, 0))
    handleFlagsChanged(event(code, flag | mask))
    pendingModifierArms["right"]?.perform()
    handleFlagsChanged(event(code, 0))
    assert(selfTestEvents == ["down:right", "up:right"], "idle typing blocked next modifier")

    for button in 0...2 {
      reset(name)
      let click = event(0, 0)
      click.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button))
      handleMouse(click, down: true)
      handleMouse(click, down: false)
      handleFlagsChanged(event(code, flag | mask))
      pendingModifierArms["right"]?.perform()
      handleFlagsChanged(event(code, 0))
      assert(selfTestEvents == ["down:right", "up:right"], "idle click blocked next modifier")
    }

    reset(name)
    handleFlagsChanged(event(otherCode, flag | otherMask))
    assert(pendingModifierArms.isEmpty && selfTestEvents!.isEmpty, "opposite side activated")
    handleFlagsChanged(event(otherCode, 0))
    handleFlagsChanged(event(code, flag | mask))
    pendingModifierArms["right"]?.perform()
    assert(selfTestEvents == ["down:right"], "right side did not arm")
    handleFlagsChanged(event(code, flag | otherMask))
    assert(selfTestEvents == ["down:right", "up:right"], "release depended on combined modifier")

    reset(name)
    handleFlagsChanged(event(code, flag | mask))
    let lateArm = pendingModifierArms["right"]!
    handleKeyDown(event(8, flag | mask))
    lateArm.perform()
    handleFlagsChanged(event(code, 0))
    assert(selfTestEvents == ["cancel:right"], "early chord did not cancel")

    reset(name)
    handleFlagsChanged(event(code, flag | mask))
    pendingModifierArms["right"]?.perform()
    handleKeyDown(event(8, flag | mask))
    handleKeyUp(event(8, flag | mask))
    handleFlagsChanged(event(code, 0))
    assert(selfTestEvents == ["down:right", "cancel:right"], "late chord inserted")

    reset(name)
    handleKeyDown(event(8, 0))
    handleFlagsChanged(event(code, flag | mask))
    assert(pendingModifierArms.isEmpty, "joined held key activated")

    reset(name)
    handleFlagsChanged(event(code, flag | mask))
    pendingModifierArms["right"]?.perform()
    handleFlagsChanged(event(otherCode, flag | mask | otherMask))
    handleFlagsChanged(event(code, flag | otherMask))
    assert(selfTestEvents == ["down:right", "cancel:right"], "opposite modifier chord inserted")

    for mouseType in [CGEventType.leftMouseDown, .rightMouseDown, .otherMouseDown] {
      for armed in [false, true] {
        reset(name)
        handleFlagsChanged(event(code, flag | mask))
        if armed { pendingModifierArms["right"]?.perform() }
        let click = event(0, flag | mask)
        click.type = mouseType
        click.setIntegerValueField(.mouseEventButtonNumber, value: mouseType == .leftMouseDown ? 0 : mouseType == .rightMouseDown ? 1 : 2)
        _ = callback(proxy: OpaquePointer(bitPattern: 1)!, type: mouseType, event: click, refcon: nil)
        handleFlagsChanged(event(code, 0))
        assert(selfTestEvents == (armed ? ["down:right", "cancel:right"] : ["cancel:right"]), "mouse chord activated")
      }
    }

    for button in 0...2 {
      reset(name)
      let click = event(0, 0)
      click.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button))
      handleMouse(click, down: true)
      handleFlagsChanged(event(code, flag | mask))
      assert(pendingModifierArms.isEmpty && !downBindingIds.contains("right"), "held mouse activated")
    }

    reset(name)
    handleFlagsChanged(event(code, flag | mask))
    handleFlagsChanged(event(code, 0))
    handleFlagsChanged(event(code, flag | mask))
    handleKeyDown(event(8, flag | mask))
    assert(selfTestEvents == ["down:right", "up:right", "cancel:right"], "second pending chord retained capture")
    let trace = try! JSONSerialization.data(withJSONObject: ["case": name + "-second-pending-chord", "events": selfTestPayloads])
    print(String(data: trace, encoding: .utf8)!)

    reset(name)
    let press = event(code, flag | mask)
    press.timestamp = 1_000_000_000
    handleFlagsChanged(press)
    let release = event(code, 0)
    release.timestamp = 1_100_000_000
    handleFlagsChanged(release)
    assert(selfTestPayloads.count == 2, "clock tap missing")
    let downTime = selfTestPayloads[0]["occurrenceEpochMs"] as! Double
    let upTime = selfTestPayloads[1]["occurrenceEpochMs"] as! Double
    assert(abs(upTime - downTime - 100) < 0.01, "event occurrence clock changed")
    assert(abs(downTime - eventEpochOffsetMs - 1000) < 0.01, "event occurrence used callback time")

    reset(name)
    handleFlagsChanged(event(code, flag | mask))
    handleFlagsChanged(event(code, 0))
    assert(selfTestEvents == ["down:right", "up:right"], "quick tap missing")
    releaseEverything()
    assert(selfTestEvents!.last == "cancel:right", "outage did not cancel")
  }
  print("PASS native shortcut physical-side, chord cancellation, release, tap, outage self-test")
}

if CommandLine.arguments.contains("--self-test") {
  runSelfTest()
  exit(0)
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
// regardless of this mask, so it only needs the input events.
let mask = eventMask(for: bindings)

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

DispatchQueue.global().async {
  while let line = readLine() {
    DispatchQueue.main.async { handleControlLine(line) }
  }
  DispatchQueue.main.async { dictationSessionActive = false }
}

activeEventTap = eventTap
let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: eventTap, enable: true)
CFRunLoopRun()
