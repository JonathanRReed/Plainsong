import AVFoundation
import CoreMedia
import Darwin
import Foundation
import Speech

private let protocolVersion = 1

private enum HelperErrorCode: String {
  case assetInstallFailed = "asset_install_failed"
  case assetsNotInstalled = "assets_not_installed"
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

/// The two recognition engines this helper can run.
///
/// `speech_analyzer` is `SpeechAnalyzer` + `SpeechTranscriber` (macOS 26+):
/// purpose-built for long-form on-device transcription, returns per-segment
/// timestamps, and downloads nothing beyond the OS-managed locale assets.
/// `sf_speech_recognizer` is the `SFSpeechRecognizer` path this helper has
/// always used, kept for macOS 13-15 and for locales whose SpeechAnalyzer
/// assets are not installed.
private enum HelperEngine: String {
  case speechAnalyzer = "speech_analyzer"
  case sfSpeechRecognizer = "sf_speech_recognizer"
}

/// How the caller asked the helper to choose between the two engines.
private enum EngineRequest: String {
  case auto
  case speechAnalyzer = "speech_analyzer"
  case sfSpeechRecognizer = "sf_speech_recognizer"
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
  let speechAnalyzerLocaleSupported: Bool
  let speechAnalyzerAssetsInstalled: Bool
  let speechAnalyzerAssetStatus: String
  let speechAnalyzerLocales: [String]
  let speechAnalyzerInstalledLocales: [String]
  let engine: String
  let operatingSystemVersion: String
}

private struct SegmentPayload: Encodable {
  let text: String
  let startSeconds: Double
  let endSeconds: Double
  let confidence: Double
}

private struct TranscriptPayload: Encodable {
  let protocolVersion: Int
  let type: String
  let text: String
  let language: String
  let confidence: Double
  let isFinal: Bool
  let engine: String
  /// Per-segment timestamps. Always empty on the `SFSpeechRecognizer` path,
  /// which reports one formatted string and no usable segment ranges; filled
  /// in on the SpeechAnalyzer path, where the meeting transcript contract
  /// needs `start_seconds`/`end_seconds` to offset and merge chunks.
  let segments: [SegmentPayload]
}

/// One SpeechAnalyzer live event. `volatile` results are the model's current
/// best guess for audio it has not finalized yet and are replaced wholesale by
/// later events; `finalized` results never change again.
private struct AnalyzerLivePayload: Encodable {
  let protocolVersion: Int
  let type: String
  let kind: String
  let text: String
  let language: String
  let startSeconds: Double
  let endSeconds: Double
  let confidence: Double
}

private struct AssetProgressPayload: Encodable {
  let protocolVersion: Int
  let type: String
  let stage: String
  let locale: String
  let fraction: Double
  let message: String
}

private struct AssetInstallPayload: Encodable {
  let protocolVersion: Int
  let type: String
  let locale: String
  let installed: Bool
  let assetStatus: String
  let engine: String
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

// MARK: - SpeechAnalyzer (macOS 26+)
//
// Everything in this section is guarded by `if #available(macOS 26, *)`. The
// helper still compiles and runs with a macOS 13.0 deployment target: on
// macOS 13-15 the guards are false, no SpeechAnalyzer symbol is ever touched,
// and the SFSpeechRecognizer paths below behave exactly as they always have.

/// A typed failure carried across an `async` boundary. `Error` is not
/// `Sendable`, so async work returns this instead and the synchronous caller
/// turns it into the same helper error protocol every other failure uses.
private struct AnalyzerFailure: Error, Sendable {
  let code: HelperErrorCode
  let message: String
  var retryable: Bool = false
  var details: [String: String] = [:]
}

/// What the helper knows about SpeechAnalyzer for one requested locale.
private struct AnalyzerFacts: Sendable {
  var apiAvailable = false
  var transcriberAvailable = false
  var localeSupported = false
  var assetsInstalled = false
  var assetStatus = "unavailable"
  var supportedLocales: [String] = []
  var installedLocales: [String] = []
  var resolvedLocale: Locale?
}

private struct AnalyzerSegment: Sendable {
  let text: String
  let startSeconds: Double
  let endSeconds: Double
  let confidence: Double
}

private struct AnalyzerTranscript: Sendable {
  let text: String
  let language: String
  let confidence: Double
  let segments: [AnalyzerSegment]
}

private final class ValueBox<T>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: T?

  func set(_ newValue: T) {
    lock.lock()
    defer { lock.unlock() }
    value = newValue
  }

  func take() -> T? {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

/// Runs an async operation to completion from the helper's synchronous
/// top-level code.
///
/// The helper is a short-lived CLI with no run loop and no `@MainActor` work,
/// so blocking the calling thread on a semaphore while Swift concurrency runs
/// the operation on its own cooperative threads cannot deadlock, and it keeps
/// the existing synchronous SFSpeechRecognizer paths untouched rather than
/// converting the whole file to top-level `await`.
private func runBlocking<T: Sendable>(_ operation: @escaping @Sendable () async -> T) -> T {
  let box = ValueBox<T>()
  let semaphore = DispatchSemaphore(value: 0)
  Task.detached(priority: .userInitiated) {
    box.set(await operation())
    semaphore.signal()
  }
  semaphore.wait()
  guard let value = box.take() else {
    fail(.recognitionFailed, "The macOS Speech helper lost an asynchronous result.")
  }
  return value
}

@available(macOS 26, *)
private func analyzerTranscriber(
  locale: Locale,
  volatileResults: Bool
) -> SpeechTranscriber {
  // `.transcription` plus timestamps: no etiquette replacements or alternative
  // transcriptions (nothing downstream reads them), audio time ranges because
  // the meeting transcript contract needs per-segment start/end, and
  // transcription confidence because the JSON contract carries a confidence.
  SpeechTranscriber(
    locale: locale,
    transcriptionOptions: [],
    reportingOptions: volatileResults ? [.volatileResults] : [],
    attributeOptions: [.audioTimeRange, .transcriptionConfidence]
  )
}

@available(macOS 26, *)
private func collectAnalyzerFacts(locale: Locale) async -> AnalyzerFacts {
  var facts = AnalyzerFacts()
  facts.apiAvailable = true
  facts.transcriberAvailable = SpeechTranscriber.isAvailable
  facts.supportedLocales = await SpeechTranscriber.supportedLocales
    .map { normalizedLocaleIdentifier($0.identifier) }
    .sorted()
  facts.installedLocales = await SpeechTranscriber.installedLocales
    .map { normalizedLocaleIdentifier($0.identifier) }
    .sorted()

  guard facts.transcriberAvailable,
    let resolved = await SpeechTranscriber.supportedLocale(equivalentTo: locale)
  else {
    facts.assetStatus = facts.transcriberAvailable ? "unsupported" : "unavailable"
    return facts
  }

  facts.localeSupported = true
  facts.resolvedLocale = resolved
  // `AssetInventory.status(forModules:)` only reports `.installed` once the
  // locale is *allocated* to this process, so a locale whose model is already
  // on disk reads back as `.supported` until `AssetInventory.reserve` runs.
  // Measured on macOS 27.0 (26A5406e): en_US was in
  // `SpeechTranscriber.installedLocales` and reported `.supported`; after
  // `reserve(locale:)` the same call reported `.installed` and the install
  // request was nil (nothing to download). The probe must not call that a
  // missing download, so "on disk" is the union of the two signals and the
  // raw inventory state is reported alongside it.
  let onDisk = facts.installedLocales.contains(normalizedLocaleIdentifier(resolved.identifier))
  let status = await AssetInventory.status(
    forModules: [analyzerTranscriber(locale: resolved, volatileResults: false)]
  )
  switch status {
  case .unsupported:
    facts.assetStatus = "unsupported"
  case .supported:
    facts.assetStatus = onDisk ? "installed_not_allocated" : "supported"
  case .downloading:
    facts.assetStatus = "downloading"
  case .installed:
    facts.assetStatus = "installed"
  @unknown default:
    facts.assetStatus = "unknown"
  }
  facts.assetsInstalled = status == .installed || onDisk
  return facts
}

/// Blocking wrapper used by the capability probe, which stays synchronous.
private func analyzerFactsForProbe(locale: Locale) -> AnalyzerFacts {
  guard #available(macOS 26, *) else { return AnalyzerFacts() }
  return runBlocking { await collectAnalyzerFacts(locale: locale) }
}

private func resolveEngine(request: EngineRequest, facts: AnalyzerFacts) -> HelperEngine {
  switch request {
  case .sfSpeechRecognizer:
    return .sfSpeechRecognizer
  case .speechAnalyzer:
    return .speechAnalyzer
  case .auto:
    // `auto` only picks SpeechAnalyzer when it can actually run right now: the
    // API exists, the locale is supported, and its assets are already on disk.
    // Anything else falls back to SFSpeechRecognizer rather than blocking on a
    // download the caller did not ask for.
    return facts.apiAvailable && facts.transcriberAvailable && facts.localeSupported
      && facts.assetsInstalled ? .speechAnalyzer : .sfSpeechRecognizer
  }
}

@available(macOS 26, *)
private func analyzerSegment(from result: SpeechTranscriber.Result) -> AnalyzerSegment {
  let attributed = result.text
  var confidenceTotal = 0.0
  var confidenceCount = 0.0
  for run in attributed.runs {
    if let value = run.transcriptionConfidence {
      confidenceTotal += value
      confidenceCount += 1
    }
  }
  let range = result.range
  return AnalyzerSegment(
    text: String(attributed.characters),
    startSeconds: range.start.isNumeric ? range.start.seconds : 0.0,
    endSeconds: range.end.isNumeric ? range.end.seconds : 0.0,
    confidence: confidenceCount > 0 ? confidenceTotal / confidenceCount : 0.0
  )
}

private func joinedAnalyzerText(_ segments: [AnalyzerSegment]) -> String {
  var text = ""
  for segment in segments {
    let piece = segment.text
    if piece.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
    if text.isEmpty {
      text = piece
    } else if text.hasSuffix(" ") || piece.hasPrefix(" ") {
      text += piece
    } else {
      text += " " + piece
    }
  }
  return text.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func averageAnalyzerConfidence(_ segments: [AnalyzerSegment]) -> Double {
  let scored = segments.filter { $0.confidence > 0 }
  guard !scored.isEmpty else { return 0.0 }
  return scored.reduce(0.0) { $0 + $1.confidence } / Double(scored.count)
}

private func analyzerErrorDetails(_ error: Error) -> [String: String] {
  let nsError = error as NSError
  return [
    "domain": nsError.domain,
    "code": String(nsError.code),
    "description": nsError.localizedDescription,
  ]
}

/// Makes sure the locale is allocated to this process before analysis.
///
/// SpeechAnalyzer fails with `assetLocaleNotAllocated` for a locale the app has
/// not reserved, even when its assets are installed. Reservation is per app and
/// capped, so a failure is reported as a typed error instead of quietly
/// releasing a locale somebody else's session reserved.
@available(macOS 26, *)
private func ensureLocaleReserved(_ locale: Locale) async -> AnalyzerFailure? {
  let normalized = normalizedLocaleIdentifier(locale.identifier)
  let reserved = await AssetInventory.reservedLocales
  if reserved.contains(where: { normalizedLocaleIdentifier($0.identifier) == normalized }) {
    return nil
  }
  do {
    _ = try await AssetInventory.reserve(locale: locale)
    return nil
  } catch {
    var details = analyzerErrorDetails(error)
    details["locale"] = normalized
    details["maximum_reserved_locales"] = String(AssetInventory.maximumReservedLocales)
    return AnalyzerFailure(
      code: .onDeviceUnavailable,
      message:
        "macOS would not allocate the SpeechAnalyzer locale to Plainsong. Free a reserved language and try again.",
      retryable: false,
      details: details
    )
  }
}

/// The shared preflight for both SpeechAnalyzer modes: the locale must be
/// supported and its assets must already be installed. Never falls back to a
/// server and never starts a download on its own.
@available(macOS 26, *)
private func analyzerReadyLocale(_ locale: Locale) async -> Result<Locale, AnalyzerFailure> {
  let facts = await collectAnalyzerFacts(locale: locale)
  guard facts.transcriberAvailable else {
    return .failure(
      AnalyzerFailure(
        code: .onDeviceUnavailable,
        message: "SpeechAnalyzer transcription is unavailable on this Mac."
      )
    )
  }
  guard facts.localeSupported, let resolved = facts.resolvedLocale else {
    return .failure(
      AnalyzerFailure(
        code: .unsupportedLocale,
        message: "SpeechAnalyzer does not support the requested locale.",
        details: ["locale": normalizedLocaleIdentifier(locale.identifier)]
      )
    )
  }
  guard facts.assetsInstalled else {
    return .failure(
      AnalyzerFailure(
        code: .assetsNotInstalled,
        message:
          "The SpeechAnalyzer language assets for this locale are not installed. Install the language, then try again.",
        details: [
          "locale": normalizedLocaleIdentifier(resolved.identifier),
          "asset_status": facts.assetStatus,
        ]
      )
    )
  }
  if let failure = await ensureLocaleReserved(resolved) {
    return .failure(failure)
  }
  return .success(resolved)
}

@available(macOS 26, *)
private func analyzerTranscribeFile(
  url: URL,
  locale: Locale
) async -> Result<AnalyzerTranscript, AnalyzerFailure> {
  let resolvedLocale: Locale
  switch await analyzerReadyLocale(locale) {
  case .failure(let failure):
    return .failure(failure)
  case .success(let value):
    resolvedLocale = value
  }

  let audioFile: AVAudioFile
  do {
    audioFile = try AVAudioFile(forReading: url)
  } catch {
    var details = analyzerErrorDetails(error)
    details["path"] = url.path
    return .failure(
      AnalyzerFailure(
        code: .malformedRequest,
        message: "Could not open the requested audio file for SpeechAnalyzer.",
        details: details
      )
    )
  }

  let transcriber = analyzerTranscriber(locale: resolvedLocale, volatileResults: false)
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let collector = Task { () throws -> [AnalyzerSegment] in
    var collected: [AnalyzerSegment] = []
    for try await result in transcriber.results {
      collected.append(analyzerSegment(from: result))
    }
    return collected
  }

  do {
    _ = try await analyzer.analyzeSequence(from: audioFile)
    try await analyzer.finalizeAndFinishThroughEndOfInput()
  } catch {
    collector.cancel()
    return .failure(
      AnalyzerFailure(
        code: .recognitionFailed,
        message: "SpeechAnalyzer transcription failed: \(error.localizedDescription)",
        retryable: true,
        details: analyzerErrorDetails(error)
      )
    )
  }

  let segments: [AnalyzerSegment]
  do {
    segments = try await collector.value
  } catch {
    return .failure(
      AnalyzerFailure(
        code: .recognitionFailed,
        message: "SpeechAnalyzer results ended in an error: \(error.localizedDescription)",
        retryable: true,
        details: analyzerErrorDetails(error)
      )
    )
  }

  let text = joinedAnalyzerText(segments)
  guard !text.isEmpty else {
    return .failure(
      AnalyzerFailure(
        code: .recognitionFailed,
        message: "SpeechAnalyzer did not recognize speech in the audio file."
      )
    )
  }
  return .success(
    AnalyzerTranscript(
      text: text,
      language: normalizedLocaleIdentifier(resolvedLocale.identifier),
      confidence: averageAnalyzerConfidence(segments),
      segments: segments
    )
  )
}

@available(macOS 26, *)
private func convertedAnalyzerBuffer(
  _ buffer: AVAudioPCMBuffer,
  converter: AVAudioConverter,
  format: AVAudioFormat
) -> AVAudioPCMBuffer? {
  let ratio = format.sampleRate / buffer.format.sampleRate
  let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
  guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
    return nil
  }
  var consumed = false
  var conversionError: NSError?
  converter.convert(to: output, error: &conversionError) { _, status in
    if consumed {
      status.pointee = .noDataNow
      return nil
    }
    consumed = true
    status.pointee = .haveData
    return buffer
  }
  if conversionError != nil { return nil }
  return output.frameLength > 0 ? output : nil
}

/// Streams SpeechAnalyzer volatile/finalized events for Float32 PCM arriving on
/// stdin, emitting one JSON line per event as it happens.
@available(macOS 26, *)
private func analyzerLiveSession(
  sampleRate: Double,
  locale: Locale
) async -> Result<AnalyzerTranscript, AnalyzerFailure> {
  let resolvedLocale: Locale
  switch await analyzerReadyLocale(locale) {
  case .failure(let failure):
    return .failure(failure)
  case .success(let value):
    resolvedLocale = value
  }
  let language = normalizedLocaleIdentifier(resolvedLocale.identifier)

  guard
    let inputFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: sampleRate,
      channels: 1,
      interleaved: false
    )
  else {
    return .failure(
      AnalyzerFailure(
        code: .malformedRequest,
        message: "The live audio sample rate is not supported.",
        details: ["sample_rate": String(sampleRate)]
      )
    )
  }

  let transcriber = analyzerTranscriber(locale: resolvedLocale, volatileResults: true)
  let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
    compatibleWith: [transcriber],
    considering: inputFormat
  )
  var converter: AVAudioConverter?
  if let analyzerFormat, analyzerFormat != inputFormat {
    guard let made = AVAudioConverter(from: inputFormat, to: analyzerFormat) else {
      return .failure(
        AnalyzerFailure(
          code: .malformedRequest,
          message: "Could not convert the live audio stream into a SpeechAnalyzer format.",
          details: [
            "input_format": inputFormat.description,
            "analyzer_format": analyzerFormat.description,
          ]
        )
      )
    }
    converter = made
  }
  let targetFormat = analyzerFormat ?? inputFormat

  let (inputStream, inputContinuation) = AsyncStream<AnalyzerInput>.makeStream()
  let collector = Task { () throws -> [AnalyzerSegment] in
    var finalized: [AnalyzerSegment] = []
    for try await result in transcriber.results {
      let segment = analyzerSegment(from: result)
      let isFinal = result.isFinal
      if isFinal {
        finalized.append(segment)
      }
      try? emit(
        AnalyzerLivePayload(
          protocolVersion: protocolVersion,
          type: "live",
          kind: isFinal ? "finalized" : "volatile",
          text: segment.text,
          language: language,
          startSeconds: segment.startSeconds,
          endSeconds: segment.endSeconds,
          confidence: segment.confidence
        )
      )
    }
    return finalized
  }

  let analyzer = SpeechAnalyzer(inputSequence: inputStream, modules: [transcriber])

  // stdin reads block, so they run on a dedicated thread instead of one of
  // Swift concurrency's cooperative threads.
  let readerQueue = DispatchQueue(label: "com.plainsong.speech-helper.live-stdin")
  let readerFailure = ValueBox<AnalyzerFailure>()
  readerQueue.async {
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
          pcmFormat: inputFormat,
          frameCapacity: AVAudioFrameCount(frameCount)
        ),
        let channelData = buffer.floatChannelData?.pointee
      else {
        readerFailure.set(
          AnalyzerFailure(
            code: .recognitionFailed,
            message: "Failed to allocate a live SpeechAnalyzer audio buffer."
          )
        )
        break
      }
      buffer.frameLength = AVAudioFrameCount(frameCount)
      chunk.withUnsafeBytes { bytes in
        if let baseAddress = bytes.baseAddress {
          memcpy(channelData, baseAddress, completeByteCount)
        }
      }

      let outgoing: AVAudioPCMBuffer?
      if let converter {
        outgoing = convertedAnalyzerBuffer(buffer, converter: converter, format: targetFormat)
      } else {
        outgoing = buffer
      }
      if let outgoing {
        inputContinuation.yield(AnalyzerInput(buffer: outgoing))
      }
    }

    if !pending.isEmpty {
      readerFailure.set(
        AnalyzerFailure(
          code: .malformedRequest,
          message: "The live audio stream ended with an incomplete Float32 sample.",
          details: ["remaining_bytes": String(pending.count)]
        )
      )
    }
    inputContinuation.finish()
  }

  do {
    try await analyzer.finalizeAndFinishThroughEndOfInput()
  } catch {
    collector.cancel()
    return .failure(
      AnalyzerFailure(
        code: .recognitionFailed,
        message: "SpeechAnalyzer live dictation failed: \(error.localizedDescription)",
        retryable: true,
        details: analyzerErrorDetails(error)
      )
    )
  }

  let segments: [AnalyzerSegment]
  do {
    segments = try await collector.value
  } catch {
    return .failure(
      AnalyzerFailure(
        code: .recognitionFailed,
        message: "SpeechAnalyzer live results ended in an error: \(error.localizedDescription)",
        retryable: true,
        details: analyzerErrorDetails(error)
      )
    )
  }

  if let failure = readerFailure.take() {
    return .failure(failure)
  }

  let text = joinedAnalyzerText(segments)
  guard !text.isEmpty else {
    return .failure(
      AnalyzerFailure(
        code: .recognitionFailed,
        message: "SpeechAnalyzer did not recognize speech in the live audio stream."
      )
    )
  }
  return .success(
    AnalyzerTranscript(
      text: text,
      language: language,
      confidence: averageAnalyzerConfidence(segments),
      segments: segments
    )
  )
}

/// Downloads and installs the OS-managed SpeechAnalyzer assets for one locale,
/// reporting progress as newline JSON so the Models screen can show it.
@available(macOS 26, *)
private func analyzerInstallAssets(locale: Locale) async -> Result<AnalyzerFacts, AnalyzerFailure> {
  guard SpeechTranscriber.isAvailable else {
    return .failure(
      AnalyzerFailure(
        code: .onDeviceUnavailable,
        message: "SpeechAnalyzer transcription is unavailable on this Mac."
      )
    )
  }
  guard let resolved = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
    return .failure(
      AnalyzerFailure(
        code: .unsupportedLocale,
        message: "SpeechAnalyzer does not support the requested locale.",
        details: ["locale": normalizedLocaleIdentifier(locale.identifier)]
      )
    )
  }
  let language = normalizedLocaleIdentifier(resolved.identifier)
  let transcriber = analyzerTranscriber(locale: resolved, volatileResults: false)

  try? emit(
    AssetProgressPayload(
      protocolVersion: protocolVersion,
      type: "progress",
      stage: "checking",
      locale: language,
      fraction: 0.0,
      message: "Checking which language assets macOS already has."
    )
  )

  let request: AssetInstallationRequest?
  do {
    request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber])
  } catch {
    var details = analyzerErrorDetails(error)
    details["locale"] = language
    return .failure(
      AnalyzerFailure(
        code: .assetInstallFailed,
        message: "macOS could not prepare the language download: \(error.localizedDescription)",
        retryable: true,
        details: details
      )
    )
  }

  if let request {
    let progress = request.progress
    let reporter = Task {
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 250_000_000)
        if Task.isCancelled { break }
        try? emit(
          AssetProgressPayload(
            protocolVersion: protocolVersion,
            type: "progress",
            stage: "downloading",
            locale: language,
            fraction: progress.fractionCompleted,
            message: "Downloading the macOS language assets."
          )
        )
      }
    }
    do {
      try await request.downloadAndInstall()
      reporter.cancel()
    } catch {
      reporter.cancel()
      var details = analyzerErrorDetails(error)
      details["locale"] = language
      return .failure(
        AnalyzerFailure(
          code: .assetInstallFailed,
          message: "The macOS language download failed: \(error.localizedDescription)",
          retryable: true,
          details: details
        )
      )
    }
  }

  if let failure = await ensureLocaleReserved(resolved) {
    return .failure(failure)
  }

  try? emit(
    AssetProgressPayload(
      protocolVersion: protocolVersion,
      type: "progress",
      stage: "verifying",
      locale: language,
      fraction: 1.0,
      message: "Verifying the installed language assets."
    )
  )
  return .success(await collectAnalyzerFacts(locale: resolved))
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
  let analyzerFacts = analyzerFactsForProbe(locale: locale)
  // "Available" means the helper could actually run SpeechAnalyzer here: the
  // macOS 26 API exists *and* SpeechTranscriber reports itself usable. Whether
  // it will run for this locale is `speech_analyzer_assets_installed` and the
  // resolved `engine` below.
  let analyzerAvailable = analyzerFacts.apiAvailable && analyzerFacts.transcriberAvailable

  return ProbePayload(
    protocolVersion: protocolVersion,
    type: "probe",
    authorization: authorization.status,
    authorizationCode: authorization.code,
    locale: normalizedRequested,
    localeSupported: localeSupported && recognizer != nil,
    onDeviceAvailable: recognizer?.supportsOnDeviceRecognition ?? false,
    recognizerAvailable: recognizer?.isAvailable ?? false,
    speechAnalyzerAvailable: analyzerAvailable,
    speechAnalyzerLocaleSupported: analyzerFacts.localeSupported,
    speechAnalyzerAssetsInstalled: analyzerFacts.assetsInstalled,
    speechAnalyzerAssetStatus: analyzerFacts.assetStatus,
    speechAnalyzerLocales: analyzerFacts.supportedLocales,
    speechAnalyzerInstalledLocales: analyzerFacts.installedLocales,
    engine: resolveEngine(request: .auto, facts: analyzerFacts).rawValue,
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
  localeIdentifier: String?,
  engineRequest: EngineRequest
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

  if #available(macOS 26, *) {
    let locale = requestedLocale(localeIdentifier)
    let engine = resolveEngine(
      request: engineRequest,
      facts: runBlocking { await collectAnalyzerFacts(locale: locale) }
    )
    if engine == .speechAnalyzer {
      runAnalyzerFileRecognition(url: inputURL, locale: locale)
    }
  } else if engineRequest == .speechAnalyzer {
    fail(
      .onDeviceUnavailable,
      "SpeechAnalyzer requires macOS 26 or later.",
      details: ["engine": EngineRequest.speechAnalyzer.rawValue]
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
        isFinal: true,
        engine: HelperEngine.sfSpeechRecognizer.rawValue,
        segments: []
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

/// Runs the SpeechAnalyzer batch path and exits; only returns to the caller
/// when the caller is expected to keep going (it never is).
@available(macOS 26, *)
private func runAnalyzerFileRecognition(url: URL, locale: Locale) -> Never {
  switch runBlocking({ await analyzerTranscribeFile(url: url, locale: locale) }) {
  case .failure(let failure):
    fail(failure.code, failure.message, retryable: failure.retryable, details: failure.details)
  case .success(let transcript):
    do {
      try emit(
        TranscriptPayload(
          protocolVersion: protocolVersion,
          type: "transcript",
          text: transcript.text,
          language: transcript.language,
          confidence: transcript.confidence,
          isFinal: true,
          engine: HelperEngine.speechAnalyzer.rawValue,
          segments: transcript.segments.map { segment in
            SegmentPayload(
              text: segment.text,
              startSeconds: segment.startSeconds,
              endSeconds: segment.endSeconds,
              confidence: segment.confidence
            )
          }
        )
      )
    } catch {
      fail(
        .recognitionFailed,
        "Failed to encode the SpeechAnalyzer transcript.",
        details: recognitionErrorDetails(error)
      )
    }
    exit(0)
  }
}

/// Runs the SpeechAnalyzer asset install and exits.
@available(macOS 26, *)
private func runAnalyzerAssetInstall(locale: Locale) -> Never {
  switch runBlocking({ await analyzerInstallAssets(locale: locale) }) {
  case .failure(let failure):
    fail(failure.code, failure.message, retryable: failure.retryable, details: failure.details)
  case .success(let facts):
    do {
      try emit(
        AssetInstallPayload(
          protocolVersion: protocolVersion,
          type: "asset_install",
          locale: facts.resolvedLocale.map { normalizedLocaleIdentifier($0.identifier) }
            ?? normalizedLocaleIdentifier(locale.identifier),
          installed: facts.assetsInstalled,
          assetStatus: facts.assetStatus,
          engine: resolveEngine(request: .auto, facts: facts).rawValue
        )
      )
    } catch {
      fail(
        .recognitionFailed,
        "Failed to encode the SpeechAnalyzer asset install result.",
        details: recognitionErrorDetails(error)
      )
    }
    exit(0)
  }
}

private func runLiveRecognition(
  sampleRate: Double,
  localeIdentifier: String?,
  engineRequest: EngineRequest
) {
  // Unlike `--transcribe-file`, live mode does not default to `auto`: the
  // SpeechAnalyzer stream emits a different event shape (volatile/finalized
  // spans instead of one growing best guess), so callers opt into it
  // explicitly and the existing consumer keeps the protocol it was written
  // against.
  if engineRequest == .speechAnalyzer {
    guard #available(macOS 26, *) else {
      fail(
        .onDeviceUnavailable,
        "SpeechAnalyzer requires macOS 26 or later.",
        details: ["engine": EngineRequest.speechAnalyzer.rawValue]
      )
    }
    runAnalyzerLiveRecognition(
      sampleRate: sampleRate,
      locale: requestedLocale(localeIdentifier)
    )
  }

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

/// Runs the SpeechAnalyzer live path and exits. Volatile and finalized events
/// were already streamed as they arrived; this emits the closing `final` line
/// in the same shape the SFSpeechRecognizer live path uses, so a consumer that
/// only wants the finished text needs no new parsing.
@available(macOS 26, *)
private func runAnalyzerLiveRecognition(sampleRate: Double, locale: Locale) -> Never {
  switch runBlocking({ await analyzerLiveSession(sampleRate: sampleRate, locale: locale) }) {
  case .failure(let failure):
    fail(failure.code, failure.message, retryable: failure.retryable, details: failure.details)
  case .success(let transcript):
    do {
      try emit(
        LiveTranscriptPayload(
          protocolVersion: protocolVersion,
          type: "final",
          event: "final",
          text: transcript.text,
          language: transcript.language,
          confidence: transcript.confidence,
          isFinal: true
        )
      )
    } catch {
      fail(
        .recognitionFailed,
        "Failed to encode the SpeechAnalyzer live transcript.",
        details: recognitionErrorDetails(error)
      )
    }
    exit(0)
  }
}

private enum HelperCommand {
  case probe(locale: String?)
  case requestAuthorization(locale: String?)
  case installAssets(locale: String?)
  case transcribeFile(path: String, locale: String?, engine: EngineRequest)
  case live(sampleRate: Double, locale: String?, engine: EngineRequest)
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
    case "--install-assets":
      return .installAssets(locale: parseLocaleOnly())
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
      let options = parseLocaleAndEngine(defaultEngine: .auto)
      return .transcribeFile(path: path, locale: options.locale, engine: options.engine)
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
      let options = parseLocaleAndEngine(defaultEngine: .auto)
      return .transcribeFile(path: first, locale: options.locale, engine: options.engine)
    }
  }

  private mutating func parseLocaleAndEngine(
    defaultEngine: EngineRequest
  ) -> (locale: String?, engine: EngineRequest) {
    var locale: String?
    var engine: EngineRequest?
    while index < arguments.count {
      let option = arguments[index]
      index += 1
      switch option {
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
      case "--engine":
        guard engine == nil, index < arguments.count,
          let parsed = EngineRequest(rawValue: arguments[index])
        else {
          fail(
            .malformedRequest,
            "--engine requires one of: auto, speech_analyzer, sf_speech_recognizer.",
            details: ["usage": usage]
          )
        }
        engine = parsed
        index += 1
      default:
        fail(
          .malformedRequest,
          "Unexpected or incomplete helper option: \(option)",
          details: ["usage": usage]
        )
      }
    }
    return (locale, engine ?? defaultEngine)
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
    var engine: EngineRequest?
    while index < arguments.count {
      let option = arguments[index]
      index += 1
      switch option {
      case "--engine":
        guard engine == nil, index < arguments.count,
          let parsed = EngineRequest(rawValue: arguments[index])
        else {
          fail(
            .malformedRequest,
            "--engine requires one of: auto, speech_analyzer, sf_speech_recognizer.",
            details: ["usage": usage]
          )
        }
        engine = parsed
        index += 1
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
    // Live keeps the SFSpeechRecognizer protocol unless SpeechAnalyzer is
    // named outright; see `runLiveRecognition`.
    return .live(
      sampleRate: sampleRate,
      locale: locale,
      engine: engine ?? .sfSpeechRecognizer
    )
  }

  private var usage: String {
    "macos_speech_helper --probe [--locale <id>] | --request-authorization [--locale <id>] | --install-assets [--locale <id>] | --transcribe-file <path> [--locale <id>] [--engine auto|speech_analyzer|sf_speech_recognizer] | --live --sample-rate <hz> [--locale <id>] [--engine speech_analyzer|sf_speech_recognizer]"
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
case .installAssets(let locale):
  guard #available(macOS 26, *) else {
    fail(
      .onDeviceUnavailable,
      "Installing Apple Speech language assets requires macOS 26 or later.",
      details: ["operation": "install_assets"]
    )
  }
  runAnalyzerAssetInstall(locale: requestedLocale(locale))
case .transcribeFile(let path, let locale, let engine):
  runFileRecognition(inputPath: path, localeIdentifier: locale, engineRequest: engine)
case .live(let sampleRate, let locale, let engine):
  runLiveRecognition(sampleRate: sampleRate, localeIdentifier: locale, engineRequest: engine)
}
