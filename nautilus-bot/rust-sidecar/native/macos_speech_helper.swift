import AVFoundation
import Darwin
import Foundation
import Speech

private let protocolVersion = 1

private enum HelperErrorCode: String {
  case authorizationDenied = "authorization_denied"
  case authorizationNotDetermined = "authorization_not_determined"
  case authorizationRestricted = "authorization_restricted"
  case cancelled = "cancelled"
  case malformedRequest = "malformed_request"
  case onDeviceUnavailable = "on_device_unavailable"
  case recognitionFailed = "recognition_failed"
  case timeout = "timeout"
  case unsupportedLocale = "unsupported_locale"
}

private struct ErrorPayload: Encodable {
  let protocolVersion: Int
  let type: String
  let code: String
  let message: String
  let retryable: Bool
  let details: [String: String]
}

private struct ProbePayload: Encodable {
  let protocolVersion: Int
  let type: String
  let authorization: String
  let authorizationCode: Int
  let locale: String
  let localeSupported: Bool
  let onDeviceAvailable: Bool
  let recognizerAvailable: Bool
  let speechAnalyzerAvailable: Bool
  let operatingSystemVersion: String
}

private struct TranscriptPayload: Encodable {
  let protocolVersion: Int
  let type: String
  let text: String
  let language: String
  let confidence: Double
  let isFinal: Bool
}

private struct LiveTranscriptPayload: Encodable {
  let protocolVersion: Int
  let type: String
  let event: String
  let text: String
  let language: String
  let confidence: Double
  let isFinal: Bool
}

private let encoder: JSONEncoder = {
  let encoder = JSONEncoder()
  encoder.keyEncodingStrategy = .convertToSnakeCase
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  return encoder
}()

private let stdoutLock = NSLock()

private func emit<T: Encodable>(_ payload: T) throws {
  let data = try encoder.encode(payload)
  stdoutLock.lock()
  defer { stdoutLock.unlock() }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
}

private func fail(
  _ code: HelperErrorCode,
  _ message: String,
  retryable: Bool = false,
  details: [String: String] = [:]
) -> Never {
  let payload = ErrorPayload(
    protocolVersion: protocolVersion,
    type: "error",
    code: code.rawValue,
    message: message,
    retryable: retryable,
    details: details
  )

  do {
    try emit(payload)
  } catch {
    let fallback =
      "{\"protocol_version\":1,\"type\":\"error\",\"code\":\"recognition_failed\",\"message\":\"Failed to encode helper error\",\"retryable\":false,\"details\":{}}\n"
    FileHandle.standardError.write(Data(fallback.utf8))
  }
  exit(1)
}

private func authorizationFields(
  _ status: SFSpeechRecognizerAuthorizationStatus
) -> (status: String, code: Int) {
  switch status {
  case .authorized:
    return ("authorized", Int(status.rawValue))
  case .notDetermined:
    return ("not_determined", Int(status.rawValue))
  case .denied:
    return ("denied", Int(status.rawValue))
  case .restricted:
    return ("restricted", Int(status.rawValue))
  @unknown default:
    return ("unknown", Int(status.rawValue))
  }
}

private func normalizedLocaleIdentifier(_ identifier: String) -> String {
  Locale(identifier: identifier).identifier.replacingOccurrences(of: "-", with: "_")
}

private func requestedLocale(_ identifier: String?) -> Locale {
  let trimmed = identifier?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return Locale(identifier: trimmed.isEmpty ? Locale.current.identifier : trimmed)
}

private func capabilityProbe(
  authorizationStatus: SFSpeechRecognizerAuthorizationStatus,
  localeIdentifier: String?
) -> ProbePayload {
  let locale = requestedLocale(localeIdentifier)
  let normalizedRequested = normalizedLocaleIdentifier(locale.identifier)
  let localeSupported = SFSpeechRecognizer.supportedLocales().contains { candidate in
    normalizedLocaleIdentifier(candidate.identifier) == normalizedRequested
  }
  let recognizer = localeSupported ? SFSpeechRecognizer(locale: locale) : nil
  let authorization = authorizationFields(authorizationStatus)

  // SpeechAnalyzer (the modern replacement for SFSpeechRecognizer) requires
  // macOS 26 / iOS 26. Use `if #available` for the runtime check since it
  // is the canonical Swift API and correctly handles SDK/deployment-target
  // edge cases that a raw major-version comparison can miss.
  let osVersion = ProcessInfo.processInfo.operatingSystemVersion
  let osVersionString = "\(osVersion.majorVersion).\(osVersion.minorVersion).\(osVersion.patchVersion)"
  var speechAnalyzerAvailable = false
  if #available(macOS 26, *) {
    speechAnalyzerAvailable = true
  }

  return ProbePayload(
    protocolVersion: protocolVersion,
    type: "probe",
    authorization: authorization.status,
    authorizationCode: authorization.code,
    locale: normalizedRequested,
    localeSupported: localeSupported && recognizer != nil,
    onDeviceAvailable: recognizer?.supportsOnDeviceRecognition ?? false,
    recognizerAvailable: recognizer?.isAvailable ?? false,
    speechAnalyzerAvailable: speechAnalyzerAvailable,
    operatingSystemVersion: osVersionString
  )
}

private func resolveProbe(promptIfNeeded: Bool, localeIdentifier: String?) -> ProbePayload {
  let initialStatus = SFSpeechRecognizer.authorizationStatus()
  guard promptIfNeeded, initialStatus == .notDetermined else {
    return capabilityProbe(
      authorizationStatus: initialStatus,
      localeIdentifier: localeIdentifier
    )
  }

  let semaphore = DispatchSemaphore(value: 0)
  let lock = NSLock()
  var resolvedStatus = initialStatus

  SFSpeechRecognizer.requestAuthorization { status in
    lock.lock()
    resolvedStatus = status
    lock.unlock()
    semaphore.signal()
  }

  if semaphore.wait(timeout: .now() + .seconds(20)) == .timedOut {
    fail(
      .timeout,
      "Timed out waiting for the macOS Speech authorization response.",
      retryable: true,
      details: ["operation": "request_authorization"]
    )
  }

  lock.lock()
  let finalStatus = resolvedStatus
  lock.unlock()
  return capabilityProbe(
    authorizationStatus: finalStatus,
    localeIdentifier: localeIdentifier
  )
}

private struct RecognitionContext {
  let recognizer: SFSpeechRecognizer
  let language: String
}

private func recognitionContext(localeIdentifier: String?) -> RecognitionContext {
  let status = SFSpeechRecognizer.authorizationStatus()
  switch status {
  case .authorized:
    break
  case .notDetermined:
    fail(
      .authorizationNotDetermined,
      "Speech Recognition permission has not been decided. Request it explicitly before transcription.",
      details: ["authorization": "not_determined"]
    )
  case .denied:
    fail(
      .authorizationDenied,
      "Speech Recognition permission is denied. Enable Plainsong in System Settings > Privacy & Security > Speech Recognition.",
      details: ["authorization": "denied"]
    )
  case .restricted:
    fail(
      .authorizationRestricted,
      "Speech Recognition permission is restricted by system policy.",
      details: ["authorization": "restricted"]
    )
  @unknown default:
    fail(
      .recognitionFailed,
      "macOS returned an unknown Speech Recognition authorization status.",
      details: ["authorization_code": String(status.rawValue)]
    )
  }

  let probe = capabilityProbe(
    authorizationStatus: status,
    localeIdentifier: localeIdentifier
  )
  guard probe.localeSupported else {
    fail(
      .unsupportedLocale,
      "Apple Speech does not support the requested locale.",
      details: ["locale": probe.locale]
    )
  }
  guard probe.onDeviceAvailable else {
    fail(
      .onDeviceUnavailable,
      "On-device Apple Speech recognition is unavailable for this locale or device.",
      details: ["locale": probe.locale]
    )
  }
  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: probe.locale)) else {
    fail(
      .unsupportedLocale,
      "Apple Speech could not create a recognizer for the requested locale.",
      details: ["locale": probe.locale]
    )
  }
  guard recognizer.supportsOnDeviceRecognition else {
    fail(
      .onDeviceUnavailable,
      "On-device Apple Speech recognition became unavailable before transcription.",
      details: ["locale": probe.locale]
    )
  }
  guard recognizer.isAvailable else {
    fail(
      .recognitionFailed,
      "Apple Speech recognition is temporarily unavailable.",
      retryable: true,
      details: ["locale": probe.locale]
    )
  }

  let callbackQueue = OperationQueue()
  callbackQueue.maxConcurrentOperationCount = 1
  callbackQueue.qualityOfService = .userInitiated
  recognizer.queue = callbackQueue
  return RecognitionContext(recognizer: recognizer, language: probe.locale)
}

private func averageConfidence(_ transcription: SFTranscription) -> Double {
  let segments = transcription.segments
  guard !segments.isEmpty else { return 0.0 }
  let total = segments.reduce(0.0) { partial, segment in
    partial + Double(segment.confidence)
  }
  return total / Double(segments.count)
}

private func classifiedRecognitionError(_ error: Error) -> HelperErrorCode {
  let nsError = error as NSError
  let description = nsError.localizedDescription.lowercased()
  if nsError.code == NSURLErrorCancelled || description.contains("cancel") {
    return .cancelled
  }
  return .recognitionFailed
}

private func recognitionErrorDetails(_ error: Error) -> [String: String] {
  let nsError = error as NSError
  return [
    "domain": nsError.domain,
    "code": String(nsError.code),
  ]
}

private final class RecognitionState: @unchecked Sendable {
  private let lock = NSLock()
  private var text = ""
  private var confidence = 0.0
  private var error: Error?
  private var finished = false
  private var finalResult = false
  private var lastEmittedText = ""

  func consume(
    result: SFSpeechRecognitionResult?,
    error incomingError: Error?,
    language: String
  ) -> (payload: LiveTranscriptPayload?, shouldSignal: Bool) {
    lock.lock()
    defer { lock.unlock() }

    if let incomingError {
      error = incomingError
      finished = true
      return (nil, true)
    }

    guard let result else { return (nil, false) }
    let candidate = result.bestTranscription.formattedString.trimmingCharacters(
      in: .whitespacesAndNewlines
    )
    if !candidate.isEmpty {
      text = candidate
      confidence = averageConfidence(result.bestTranscription)
    }

    var payload: LiveTranscriptPayload?
    if !candidate.isEmpty, candidate != lastEmittedText || result.isFinal {
      payload = LiveTranscriptPayload(
        protocolVersion: protocolVersion,
        type: result.isFinal ? "final" : "partial",
        event: result.isFinal ? "final" : "partial",
        text: candidate,
        language: language,
        confidence: confidence,
        isFinal: result.isFinal
      )
      lastEmittedText = candidate
    }

    if result.isFinal {
      finished = true
      finalResult = true
      return (payload, true)
    }
    return (payload, false)
  }

  func snapshot() -> (
    text: String,
    confidence: Double,
    error: Error?,
    finished: Bool,
    finalResult: Bool
  ) {
    lock.lock()
    defer { lock.unlock() }
    return (text, confidence, error, finished, finalResult)
  }
}

private func audioDurationSeconds(_ url: URL) -> Double {
  guard let file = try? AVAudioFile(forReading: url) else { return 0 }
  let sampleRate = file.processingFormat.sampleRate
  guard sampleRate > 0 else { return 0 }
  return Double(file.length) / sampleRate
}

private func runFileRecognition(
  inputPath: String,
  localeIdentifier: String?
) {
  let inputURL = URL(fileURLWithPath: inputPath)
  var isDirectory: ObjCBool = false
  guard FileManager.default.fileExists(atPath: inputURL.path, isDirectory: &isDirectory),
    !isDirectory.boolValue
  else {
    fail(
      .malformedRequest,
      "The requested audio file does not exist or is not a regular file.",
      details: ["path": inputPath]
    )
  }

  let context = recognitionContext(localeIdentifier: localeIdentifier)
  let request = SFSpeechURLRecognitionRequest(url: inputURL)
  request.shouldReportPartialResults = true
  request.taskHint = .dictation
  request.requiresOnDeviceRecognition = true
  request.addsPunctuation = true

  let semaphore = DispatchSemaphore(value: 0)
  let state = RecognitionState()
  let task = context.recognizer.recognitionTask(with: request) { result, error in
    let update = state.consume(result: result, error: error, language: context.language)
    if update.shouldSignal {
      semaphore.signal()
    }
  }

  let duration = audioDurationSeconds(inputURL)
  let timeoutSeconds = min(max(Int(ceil(duration * 3.0)) + 15, 15), 480)
  if semaphore.wait(timeout: .now() + .seconds(timeoutSeconds)) == .timedOut {
    let snapshot = state.snapshot()
    if !snapshot.finished {
      task.cancel()
      fail(
        .timeout,
        "Apple Speech transcription timed out.",
        retryable: true,
        details: [
          "operation": "transcribe_file",
          "timeout_seconds": String(timeoutSeconds),
        ]
      )
    }
  }

  let snapshot = state.snapshot()
  if let error = snapshot.error {
    let code = classifiedRecognitionError(error)
    fail(
      code,
      code == .cancelled
        ? "Apple Speech transcription was cancelled."
        : "Apple Speech recognition failed: \(error.localizedDescription)",
      retryable: code == .recognitionFailed,
      details: recognitionErrorDetails(error)
    )
  }
  guard snapshot.finalResult else {
    fail(
      .recognitionFailed,
      "Apple Speech ended without a final transcription result.",
      retryable: true
    )
  }

  let completedText = snapshot.text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !completedText.isEmpty else {
    fail(
      .recognitionFailed,
      "Apple Speech did not recognize speech in the audio file."
    )
  }

  do {
    try emit(
      TranscriptPayload(
        protocolVersion: protocolVersion,
        type: "transcript",
        text: completedText,
        language: context.language,
        confidence: snapshot.confidence,
        isFinal: true
      )
    )
  } catch {
    fail(
      .recognitionFailed,
      "Failed to encode the Apple Speech transcript.",
      details: recognitionErrorDetails(error)
    )
  }
}

private func runLiveRecognition(
  sampleRate: Double,
  localeIdentifier: String?
) {
  let context = recognitionContext(localeIdentifier: localeIdentifier)
  let request = SFSpeechAudioBufferRecognitionRequest()
  request.shouldReportPartialResults = true
  request.taskHint = .dictation
  request.requiresOnDeviceRecognition = true
  request.addsPunctuation = true

  guard
    let format = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: sampleRate,
      channels: 1,
      interleaved: false
    )
  else {
    fail(
      .malformedRequest,
      "The live audio sample rate is not supported.",
      details: ["sample_rate": String(sampleRate)]
    )
  }

  let semaphore = DispatchSemaphore(value: 0)
  let state = RecognitionState()
  let task = context.recognizer.recognitionTask(with: request) { result, error in
    let update = state.consume(result: result, error: error, language: context.language)
    if let payload = update.payload {
      do {
        try emit(payload)
      } catch {
        // The final state below reports an encoding failure if no final line arrives.
      }
    }
    if update.shouldSignal {
      semaphore.signal()
    }
  }

  let stdin = FileHandle.standardInput
  let bytesPerSample = MemoryLayout<Float>.size
  var pending = Data()

  while true {
    let data = stdin.availableData
    if data.isEmpty { break }
    pending.append(data)

    let completeByteCount = pending.count - (pending.count % bytesPerSample)
    guard completeByteCount > 0 else { continue }

    let chunk = pending.prefix(completeByteCount)
    pending.removeFirst(completeByteCount)
    let frameCount = completeByteCount / bytesPerSample
    guard
      let buffer = AVAudioPCMBuffer(
        pcmFormat: format,
        frameCapacity: AVAudioFrameCount(frameCount)
      )
    else {
      task.cancel()
      fail(.recognitionFailed, "Failed to allocate a live Apple Speech audio buffer.")
    }
    buffer.frameLength = AVAudioFrameCount(frameCount)

    guard let channelData = buffer.floatChannelData?.pointee else {
      task.cancel()
      fail(.recognitionFailed, "Failed to access the live Apple Speech audio buffer.")
    }
    chunk.withUnsafeBytes { bytes in
      if let baseAddress = bytes.baseAddress {
        memcpy(channelData, baseAddress, completeByteCount)
      }
    }
    request.append(buffer)
  }

  if !pending.isEmpty {
    task.cancel()
    fail(
      .malformedRequest,
      "The live audio stream ended with an incomplete Float32 sample.",
      details: ["remaining_bytes": String(pending.count)]
    )
  }

  request.endAudio()
  let timeoutSeconds = 15
  if semaphore.wait(timeout: .now() + .seconds(timeoutSeconds)) == .timedOut {
    let snapshot = state.snapshot()
    if !snapshot.finished {
      task.cancel()
      fail(
        .timeout,
        "Apple Speech live dictation timed out waiting for a final result.",
        retryable: true,
        details: [
          "operation": "live_dictation",
          "timeout_seconds": String(timeoutSeconds),
        ]
      )
    }
  }

  let snapshot = state.snapshot()
  if let error = snapshot.error {
    let code = classifiedRecognitionError(error)
    fail(
      code,
      code == .cancelled
        ? "Apple Speech live dictation was cancelled."
        : "Apple Speech live dictation failed: \(error.localizedDescription)",
      retryable: code == .recognitionFailed,
      details: recognitionErrorDetails(error)
    )
  }
  guard snapshot.finalResult else {
    fail(
      .recognitionFailed,
      "Apple Speech live dictation ended without a final result.",
      retryable: true
    )
  }
  guard !snapshot.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    fail(.recognitionFailed, "Apple Speech did not recognize speech in the live audio stream.")
  }
}

private enum HelperCommand {
  case probe(locale: String?)
  case requestAuthorization(locale: String?)
  case transcribeFile(path: String, locale: String?)
  case live(sampleRate: Double, locale: String?)
}

private struct ArgumentParser {
  let arguments: [String]
  private var index = 0

  init(arguments: [String]) {
    self.arguments = arguments
  }

  mutating func parse() -> HelperCommand {
    guard !arguments.isEmpty else {
      fail(
        .malformedRequest,
        "Missing helper command.",
        details: ["usage": usage]
      )
    }

    let first = arguments[0]
    index = 1
    switch first {
    case "--probe":
      return .probe(locale: parseLocaleOnly())
    case "--request-authorization":
      return .requestAuthorization(locale: parseLocaleOnly())
    case "--transcribe-file":
      guard index < arguments.count else {
        fail(
          .malformedRequest,
          "--transcribe-file requires an audio file path.",
          details: ["usage": usage]
        )
      }
      let path = arguments[index]
      index += 1
      return .transcribeFile(path: path, locale: parseLocaleOnly())
    case "--live":
      return parseLive()
    default:
      if first.hasPrefix("--") {
        fail(
          .malformedRequest,
          "Unknown helper command: \(first)",
          details: ["usage": usage]
        )
      }
      return .transcribeFile(path: first, locale: parseLocaleOnly())
    }
  }

  private mutating func parseLocaleOnly() -> String? {
    var locale: String?
    while index < arguments.count {
      let option = arguments[index]
      index += 1
      guard option == "--locale", index < arguments.count else {
        fail(
          .malformedRequest,
          "Unexpected or incomplete helper option: \(option)",
          details: ["usage": usage]
        )
      }
      guard locale == nil else {
        fail(.malformedRequest, "--locale may only be supplied once.")
      }
      locale = arguments[index]
      index += 1
    }
    return locale
  }

  private mutating func parseLive() -> HelperCommand {
    var sampleRate: Double?
    var locale: String?
    while index < arguments.count {
      let option = arguments[index]
      index += 1
      switch option {
      case "--sample-rate":
        guard sampleRate == nil,
          index < arguments.count,
          let parsed = Double(arguments[index]),
          parsed.isFinite,
          parsed > 0
        else {
          fail(
            .malformedRequest,
            "--sample-rate requires one positive finite number.",
            details: ["usage": usage]
          )
        }
        sampleRate = parsed
        index += 1
      case "--locale":
        guard locale == nil, index < arguments.count else {
          fail(
            .malformedRequest,
            "--locale requires one locale identifier.",
            details: ["usage": usage]
          )
        }
        locale = arguments[index]
        index += 1
      default:
        fail(
          .malformedRequest,
          "Unknown live helper option: \(option)",
          details: ["usage": usage]
        )
      }
    }

    guard let sampleRate else {
      fail(
        .malformedRequest,
        "--live requires --sample-rate <hz>.",
        details: ["usage": usage]
      )
    }
    return .live(sampleRate: sampleRate, locale: locale)
  }

  private var usage: String {
    "macos_speech_helper --probe [--locale <id>] | --request-authorization [--locale <id>] | --transcribe-file <path> [--locale <id>] | --live --sample-rate <hz> [--locale <id>]"
  }
}

private var parser = ArgumentParser(arguments: Array(CommandLine.arguments.dropFirst()))
switch parser.parse() {
case .probe(let locale):
  do {
    try emit(resolveProbe(promptIfNeeded: false, localeIdentifier: locale))
  } catch {
    fail(
      .recognitionFailed,
      "Failed to encode the Apple Speech capability probe.",
      details: recognitionErrorDetails(error)
    )
  }
case .requestAuthorization(let locale):
  do {
    try emit(resolveProbe(promptIfNeeded: true, localeIdentifier: locale))
  } catch {
    fail(
      .recognitionFailed,
      "Failed to encode the Apple Speech authorization result.",
      details: recognitionErrorDetails(error)
    )
  }
case .transcribeFile(let path, let locale):
  runFileRecognition(inputPath: path, localeIdentifier: locale)
case .live(let sampleRate, let locale):
  runLiveRecognition(sampleRate: sampleRate, localeIdentifier: locale)
}
