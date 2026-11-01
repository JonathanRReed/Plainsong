import Foundation

#if canImport(FoundationModels)
  import FoundationModels
#endif

// Apple on-device model helper for cleanup and chunked notes.
//
// Four things this helper deliberately does NOT do:
//
//  1. It never reaches the network. `SystemLanguageModel.default` is the
//     on-device model; there is no Private Cloud Compute path in this file and
//     no URLSession anywhere in it. That is the whole reason this provider is
//     allowed to run without the remote-processing gate.
//  2. It never takes instructions from the transcript. The instructions string
//     is supplied by the sidecar and the transcript is passed as the prompt,
//     which is the same fencing every other provider in llm/ uses. This
//     process does not concatenate the two.
//  3. It never persists anything. No transcript, no response, no log file. It
//     answers one request on stdin and exits.
//  4. It never prompts. Availability is read, not requested; there is no API
//     here that can put a dialog on screen.
//
// The build is guarded with `#if canImport(FoundationModels)` so the source
// compiles against any SDK. Built against an older SDK it still runs, and
// every request answers `available: false` with `code: framework_unavailable`,
// which is exactly what the sidecar's startup probe expects to see on a Mac
// that cannot run this provider.

private let protocolVersion = 1

/// A conservative character cap for dictation. Notes use token-aware chunks
/// and a separate byte ceiling below.
private let maximumTranscriptCharacters = 4096

/// Nothing here should ever take this long on-device. A hung request must not
/// hold the dictation insertion path open past its budget, and the sidecar
/// kills us anyway -- this is belt and braces so an abandoned helper exits.
private let requestTimeoutSeconds: Double = 20

private enum HelperErrorCode: String {
  case frameworkUnavailable = "framework_unavailable"
  case osTooOld = "os_too_old"
  case malformedRequest = "malformed_request"
  case modelUnavailable = "model_unavailable"
  case generationFailed = "generation_failed"
  case guardrailViolation = "guardrail_violation"
  case contextWindowExceeded = "context_window_exceeded"
  case outputLimit = "output_limit"
  case timeout = "timeout"
}

private struct HelperRequest: Decodable {
  let protocolVersion: Int?
  let mode: String
  let instructions: String?
  let prompt: String?
  let maximumResponseTokens: Int?
  let responseKind: String?
}

private struct ErrorPayload: Encodable {
  let protocolVersion: Int
  let type: String
  let code: String
  let message: String
  let retryable: Bool
}

private struct ProbePayload: Encodable {
  let protocolVersion: Int
  let type: String
  let available: Bool
  /// Machine-readable reason when `available` is false. `nil` when available.
  let reason: String?
  /// One sentence a person can act on, or `nil` when available.
  let detail: String?
  let operatingSystemVersion: String
  var contextTokens: Int? = nil
}

private struct CompletionPayload: Encodable {
  let protocolVersion: Int
  let type: String
  let text: String
}

private func emit<T: Encodable>(_ payload: T) {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  guard let data = try? encoder.encode(payload),
    let line = String(data: data, encoding: .utf8)
  else {
    FileHandle.standardError.write(Data("failed to encode helper payload\n".utf8))
    exit(70)
  }
  print(line)
}

private func emitError(_ code: HelperErrorCode, _ message: String, retryable: Bool = false) -> Never {
  emit(
    ErrorPayload(
      protocolVersion: protocolVersion,
      type: "error",
      code: code.rawValue,
      message: message,
      retryable: retryable
    ))
  exit(0)
}

private func operatingSystemVersionString() -> String {
  let version = ProcessInfo.processInfo.operatingSystemVersion
  return "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
}

private func readRequest() -> HelperRequest {
  guard let data = try? FileHandle.standardInput.readToEnd(), !data.isEmpty else {
    emitError(.malformedRequest, "The helper received no request on stdin.")
  }
  guard let request = try? JSONDecoder().decode(HelperRequest.self, from: data) else {
    emitError(.malformedRequest, "The helper could not parse the request as JSON.")
  }
  if let version = request.protocolVersion, version != protocolVersion {
    emitError(
      .malformedRequest,
      "Unsupported request protocol version \(version); this helper speaks \(protocolVersion).")
  }
  return request
}

// MARK: - Availability

#if canImport(FoundationModels)

  @available(macOS 26.0, *)
  private func availabilityReason() -> (String, String)? {
    switch SystemLanguageModel.default.availability {
    case .available:
      return nil
    case .unavailable(let reason):
      switch reason {
      case .deviceNotEligible:
        return (
          "device_not_eligible",
          "This Mac does not support Apple Intelligence, so the Apple on-device model cannot run here."
        )
      case .appleIntelligenceNotEnabled:
        return (
          "apple_intelligence_not_enabled",
          "Apple Intelligence is turned off. Turn it on in System Settings to use the Apple on-device model."
        )
      case .modelNotReady:
        return (
          "model_not_ready",
          "Apple Intelligence is still downloading its model. Try again once it has finished."
        )
      @unknown default:
        return ("unavailable", "The Apple on-device model is unavailable on this Mac.")
      }
    @unknown default:
      return ("unavailable", "The Apple on-device model is unavailable on this Mac.")
    }
  }

#endif

#if canImport(FoundationModels)
@available(macOS 26.0, *)
private func modelContextTokens() -> Int {
  #if PLAINSONG_APPLE_CONTEXT_SIZE
  return SystemLanguageModel.default.contextSize
  #else
  return 4096
  #endif
}
#endif

private func runProbe() -> Never {
  #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
      let reason = availabilityReason()
      emit(
        ProbePayload(
          protocolVersion: protocolVersion,
          type: "probe",
          available: reason == nil,
          reason: reason?.0,
          detail: reason?.1,
          operatingSystemVersion: operatingSystemVersionString(),
          contextTokens: modelContextTokens()
        ))
      exit(0)
    }
    emit(
      ProbePayload(
        protocolVersion: protocolVersion,
        type: "probe",
        available: false,
        reason: HelperErrorCode.osTooOld.rawValue,
        detail:
          "The Apple on-device model needs macOS 26 or newer; this Mac runs \(operatingSystemVersionString()).",
        operatingSystemVersion: operatingSystemVersionString()
      ))
    exit(0)
  #else
    emit(
      ProbePayload(
        protocolVersion: protocolVersion,
        type: "probe",
        available: false,
        reason: HelperErrorCode.frameworkUnavailable.rawValue,
        detail:
          "This build of Plainsong was compiled without the Apple Foundation Models framework.",
        operatingSystemVersion: operatingSystemVersionString()
      ))
    exit(0)
  #endif
}

#if canImport(FoundationModels)
@available(macOS 26.0, *)
private func notesSchema(_ kind: String?) throws -> GenerationSchema? {
  let text = DynamicGenerationSchema(type: String.self)
  let ids = DynamicGenerationSchema(arrayOf: text)
  let root: DynamicGenerationSchema
  var dependencies: [DynamicGenerationSchema] = []
  switch kind {
  case "evidence":
    let fact = DynamicGenerationSchema(name: "MeetingFact", properties: [
      .init(name: "fact", schema: text), .init(name: "lineIds", schema: ids)
    ])
    dependencies = [fact]
    root = DynamicGenerationSchema(name: "NotesEvidence", properties: [
      .init(name: "evidence", schema: .init(arrayOf: .init(referenceTo: "MeetingFact")))
    ])
  case "actionItems":
    let action = DynamicGenerationSchema(name: "MeetingAction", properties: [
      .init(name: "task", schema: text),
      .init(name: "assignee", schema: text, isOptional: true),
      .init(name: "deadline", schema: text, isOptional: true),
      .init(name: "lineIds", schema: ids)
    ])
    dependencies = [action]
    root = DynamicGenerationSchema(name: "NotesActions", properties: [
      .init(name: "actionItems", schema: .init(arrayOf: .init(referenceTo: "MeetingAction")))
    ])
  case "response":
    root = DynamicGenerationSchema(name: "NotesResponse", properties: [
      .init(name: "response", schema: text), .init(name: "lineIds", schema: ids)
    ])
  default: return nil
  }
  return try GenerationSchema(root: root, dependencies: dependencies)
}
#endif

// MARK: - Generation

private func runGenerate(_ request: HelperRequest) -> Never {
  guard let prompt = request.prompt, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  else {
    emitError(.malformedRequest, "The helper received an empty prompt.")
  }
  guard request.mode == "notes" ? prompt.utf8.count <= 48 * 1024 : prompt.count <= maximumTranscriptCharacters else {
    emitError(
      .contextWindowExceeded,
      "This text is too long for the Apple on-device model. The original text was kept.")
  }
  let instructions = request.instructions ?? ""
  guard !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    emitError(.malformedRequest, "The helper received no instructions.")
  }

  #if canImport(FoundationModels)
    guard #available(macOS 26.0, *) else {
      emitError(
        .osTooOld,
        "The Apple on-device model needs macOS 26 or newer; this Mac runs \(operatingSystemVersionString())."
      )
    }
    if let reason = availabilityReason() {
      // "still downloading" is the one unavailability a later attempt can
      // clear on its own; the other two need the user to change something.
      emitError(.modelUnavailable, reason.1, retryable: reason.0 == "model_not_ready")
    }

    let semaphore = DispatchSemaphore(value: 0)
    // `nonisolated(unsafe)` rather than an actor: this is a single-shot CLI
    // with exactly one writer (the Task below) and one reader (after the
    // semaphore), so the handoff is already ordered.
    nonisolated(unsafe) var outcome: Result<String, Error>?

    let task = Task {
      do {
        let session = LanguageModelSession(instructions: instructions)
        var options = GenerationOptions(sampling: .greedy)
        if let limit = request.maximumResponseTokens, limit > 0 {
          options = GenerationOptions(sampling: .greedy, maximumResponseTokens: limit)
        }
        if request.mode == "notes" {
          let schema = try notesSchema(request.responseKind)
          var inputTokens = (prompt.utf8.count + instructions.utf8.count + 2) / 3
          #if PLAINSONG_APPLE_TOKEN_COUNT
          if #available(macOS 26.4, *) {
            let model = SystemLanguageModel.default
            let promptTokens = try await model.tokenCount(for: prompt)
            let instructionTokens = try await model.tokenCount(for: Instructions(instructions))
            let schemaTokens: Int
            if let schema { schemaTokens = try await model.tokenCount(for: schema) }
            else { schemaTokens = 0 }
            inputTokens = promptTokens + instructionTokens + schemaTokens
          }
          #endif
          guard inputTokens + (request.maximumResponseTokens ?? 1024) + 384 <= modelContextTokens() else {
            emitError(.contextWindowExceeded, "This part of the meeting exceeds the on-device model's window. The transcript was kept.")
          }
          if let schema {
            let response = try await session.respond(to: prompt, schema: schema, includeSchemaInPrompt: true, options: options)
            try requireCompleteResponse(response.content)
            outcome = .success(response.content.jsonString)
          } else {
            let response = try await session.respond(to: prompt, options: options)
            try requireCompleteResponse(response.rawContent)
            outcome = .success(response.content)
          }
        } else {
          let response = try await session.respond(to: prompt, options: options)
          try requireCompleteResponse(response.rawContent)
          outcome = .success(response.content)
        }
      } catch {
        outcome = .failure(error)
      }
      semaphore.signal()
    }

    if semaphore.wait(timeout: .now() + (request.mode == "notes" ? 60 : requestTimeoutSeconds)) == .timedOut {
      task.cancel()
      emitError(.timeout, "The Apple on-device model did not answer in time.", retryable: true)
    }

    switch outcome {
    case .success(let text):
      emit(
        CompletionPayload(protocolVersion: protocolVersion, type: "completion", text: text))
      exit(0)
    case .failure(let error):
      emitError(classify(error), describe(error), retryable: isRetryable(error))
    case nil:
      emitError(.generationFailed, "The Apple on-device model returned no result.")
    }
  #else
    emitError(
      .frameworkUnavailable,
      "This build of Plainsong was compiled without the Apple Foundation Models framework.")
  #endif
}

#if canImport(FoundationModels)

  private struct IncompleteResponse: Error {}

  @available(macOS 26.0, *)
  private func requireCompleteResponse(_ content: GeneratedContent) throws {
    guard content.isComplete else { throw IncompleteResponse() }
  }

  @available(macOS 26.0, *)
  private func classify(_ error: Error) -> HelperErrorCode {
    if error is IncompleteResponse { return .outputLimit }
    guard let generationError = error as? LanguageModelSession.GenerationError else {
      return .generationFailed
    }
    switch generationError {
    case .exceededContextWindowSize:
      return .contextWindowExceeded
    case .guardrailViolation:
      return .guardrailViolation
    case .assetsUnavailable:
      return .modelUnavailable
    default:
      return .generationFailed
    }
  }

  @available(macOS 26.0, *)
  private func describe(_ error: Error) -> String {
    // The transcript can appear inside a guardrail message, so the wording
    // here is ours and the framework's own string is not echoed back into the
    // app's logs or UI.
    switch classify(error) {
    case .outputLimit:
      return "The Apple on-device model returned unfinished text. It was not used."
    case .contextWindowExceeded:
      return "This text exceeds the Apple on-device model's window. The original text was kept."
    case .guardrailViolation:
      return "Apple's on-device safety filter declined to process this text."
    case .modelUnavailable:
      return "Apple Intelligence has not finished downloading its model on this Mac."
    default:
      return "The Apple on-device model could not process this text."
    }
  }

  @available(macOS 26.0, *)
  private func isRetryable(_ error: Error) -> Bool {
    classify(error) == .modelUnavailable
  }

#endif

// MARK: - Entry point

private let request = readRequest()
switch request.mode {
case "probe":
  runProbe()
case "generate", "notes":
  runGenerate(request)
default:
  emitError(.malformedRequest, "Unknown helper mode '\(request.mode)'.")
}
