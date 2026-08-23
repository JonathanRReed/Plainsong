import ApplicationServices
import Foundation

func argumentValue(_ name: String) -> String? {
  guard let index = CommandLine.arguments.firstIndex(of: name),
        index + 1 < CommandLine.arguments.count else {
    return nil
  }
  return CommandLine.arguments[index + 1]
}

let keyCode = CGKeyCode(UInt16(argumentValue("--key-code") ?? "49") ?? 49)
let flagsRaw = UInt64(argumentValue("--flags") ?? "1179648") ?? 1_179_648
let maxHoldMs = UInt64(argumentValue("--max-hold-ms") ?? "30000") ?? 30_000

guard let source = CGEventSource(stateID: .hidSystemState),
      let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
      let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
  fputs("Unable to create CGEvent hold pair.\n", stderr)
  exit(1)
}

let flags = CGEventFlags(rawValue: flagsRaw)
down.flags = flags
up.flags = flags

let releaseLock = NSLock()
var released = false

func releaseKey() {
  releaseLock.lock()
  defer { releaseLock.unlock() }
  guard !released else { return }
  released = true
  up.post(tap: .cghidEventTap)
  print("up")
  fflush(stdout)
}

// The watchdog is inside the process that owns the event source. If the Node
// harness stalls, the key is still released without waiting for that parent.
DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(Int(maxHoldMs))) {
  releaseKey()
  exit(2)
}

down.post(tap: .cghidEventTap)
print("down")
fflush(stdout)

// Node keeps stdin open for the duration of the spoken fixture and writes one
// newline to release. A parent exit closes the pipe, so readLine returns and
// releases the key even on normal harness teardown.
_ = readLine()
releaseKey()
