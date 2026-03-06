import AVFoundation
import Foundation
import Speech

struct OutputPayload: Codable {
    let text: String
    let language: String
    let confidence: Double
}

struct LiveOutputPayload: Codable {
    let event: String
    let text: String
    let language: String
    let confidence: Double
    let isFinal: Bool
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func makeRecognizer() -> SFSpeechRecognizer {
    guard let recognizer = SFSpeechRecognizer() else {
        fail("Failed to create macOS Speech recognizer for current locale.")
    }
    guard recognizer.isAvailable else {
        fail("macOS Speech recognizer is currently unavailable.")
    }

    // Speech callbacks default to the app main queue. This helper is a CLI sidecar
    // that waits synchronously, so use a dedicated queue to avoid callback starvation.
    let callbackQueue = OperationQueue()
    callbackQueue.maxConcurrentOperationCount = 1
    callbackQueue.qualityOfService = .userInitiated
    recognizer.queue = callbackQueue
    return recognizer
}

func updateConfidence(from transcription: SFTranscription) -> Double {
    let segments = transcription.segments
    guard !segments.isEmpty else {
        return 0.0
    }
    let sum = segments.reduce(0.0) { partial, segment in
        partial + Double(segment.confidence)
    }
    return sum / Double(segments.count)
}

func emitLivePayload(_ payload: LiveOutputPayload) {
    do {
        let data = try JSONEncoder().encode(payload)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    } catch {
        FileHandle.standardError.write(
            Data(("Failed to encode live speech payload: \(error.localizedDescription)\n").utf8)
        )
    }
}

func audioDurationSeconds(for url: URL) -> Double {
    do {
        let file = try AVAudioFile(forReading: url)
        let frameCount = Double(file.length)
        let sampleRate = file.processingFormat.sampleRate
        if sampleRate > 0 {
            return frameCount / sampleRate
        }
    } catch {
        // Ignore duration probe errors and use default timeout below.
    }
    return 0
}

func runFileRecognition(inputPath: String) {
    let inputUrl = URL(fileURLWithPath: inputPath)
    guard FileManager.default.fileExists(atPath: inputUrl.path) else {
        fail("Audio file does not exist: \(inputPath)")
    }

    let recognizer = makeRecognizer()
    let request = SFSpeechURLRecognitionRequest(url: inputUrl)
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    if #available(macOS 10.15, *) {
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
    }
    if #available(macOS 13.0, *) {
        request.addsPunctuation = true
    }

    let transcriptionSemaphore = DispatchSemaphore(value: 0)
    let stateLock = NSLock()
    var finalText = ""
    var language = recognizer.locale.identifier
    var confidence: Double = 0.0
    var taskError: String?
    var didFinish = false
    var sawAnyResult = false

    let task = recognizer.recognitionTask(with: request) { result, error in
        stateLock.lock()
        defer { stateLock.unlock() }

        if let error = error {
            taskError = error.localizedDescription
            didFinish = true
            transcriptionSemaphore.signal()
            return
        }

        guard let result = result else { return }

        sawAnyResult = true
        let candidate = result.bestTranscription.formattedString.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        if !candidate.isEmpty {
            finalText = candidate
            confidence = updateConfidence(from: result.bestTranscription)
        }

        if result.isFinal {
            didFinish = true
            transcriptionSemaphore.signal()
        }
    }

    let durationSeconds = audioDurationSeconds(for: inputUrl)
    let timeoutSeconds = min(max(Int(ceil(durationSeconds * 3.0)) + 15, 15), 480)
    if transcriptionSemaphore.wait(timeout: .now() + .seconds(timeoutSeconds)) == .timedOut {
        task.cancel()
        stateLock.lock()
        let timedOutText = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
        let hadResult = sawAnyResult
        let timeoutTaskError = taskError
        stateLock.unlock()
        if !timedOutText.isEmpty || hadResult {
            finalText = timedOutText
        } else if let timeoutTaskError {
            fail("macOS Speech timed out after \(timeoutSeconds)s (\(timeoutTaskError)).")
        } else {
            fail("macOS Speech transcription timed out after \(timeoutSeconds)s.")
        }
    }

    task.cancel()

    stateLock.lock()
    let completedText = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
    let completedError = taskError
    let completedFinal = didFinish
    stateLock.unlock()

    if !completedFinal && completedText.isEmpty {
        fail("macOS Speech transcription did not finish.")
    }

    if let completedError, completedText.isEmpty {
        fail("macOS Speech error: \(completedError)")
    }

    if completedText.isEmpty {
        fail("No speech recognized from audio file.")
    }

    let payload = OutputPayload(text: completedText, language: recognizer.locale.identifier, confidence: confidence)
    do {
        let data = try JSONEncoder().encode(payload)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    } catch {
        fail("Failed to encode transcription payload: \(error.localizedDescription)")
    }
}

func runLiveRecognition(sampleRate: Double) {
    let recognizer = makeRecognizer()
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    if #available(macOS 10.15, *) {
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
    }
    if #available(macOS 13.0, *) {
        request.addsPunctuation = true
    }

    guard let format = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: sampleRate,
        channels: 1,
        interleaved: false
    ) else {
        fail("Failed to create Apple Speech live audio format.")
    }

    let transcriptionSemaphore = DispatchSemaphore(value: 0)
    let stateLock = NSLock()
    var finalText = ""
    var language = recognizer.locale.identifier
    var confidence: Double = 0.0
    var taskError: String?
    var didFinish = false
    var sawAnyResult = false
    var lastEmittedText = ""

    let task = recognizer.recognitionTask(with: request) { result, error in
        stateLock.lock()
        defer { stateLock.unlock() }

        if let error = error {
            taskError = error.localizedDescription
            didFinish = true
            transcriptionSemaphore.signal()
            return
        }

        guard let result = result else { return }

        sawAnyResult = true
        let candidate = result.bestTranscription.formattedString.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        if !candidate.isEmpty {
            finalText = candidate
            confidence = updateConfidence(from: result.bestTranscription)
            let shouldEmit = candidate != lastEmittedText || result.isFinal
            if shouldEmit {
                emitLivePayload(
                    LiveOutputPayload(
                        event: result.isFinal ? "final" : "partial",
                        text: candidate,
                        language: language,
                        confidence: confidence,
                        isFinal: result.isFinal
                    )
                )
                lastEmittedText = candidate
            }
        }

        if result.isFinal {
            didFinish = true
            transcriptionSemaphore.signal()
        }
    }

    let stdinHandle = FileHandle.standardInput
    let bytesPerSample = MemoryLayout<Float>.size
    var pending = Data()

    while true {
        let data = stdinHandle.availableData
        if data.isEmpty {
            break
        }

        pending.append(data)
        let completeByteCount = pending.count - (pending.count % bytesPerSample)
        if completeByteCount <= 0 {
            continue
        }

        let chunk = pending.prefix(completeByteCount)
        pending.removeFirst(completeByteCount)
        let frameCount = completeByteCount / bytesPerSample
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(frameCount)
        ) else {
            fail("Failed to allocate Apple Speech live audio buffer.")
        }
        buffer.frameLength = AVAudioFrameCount(frameCount)
        chunk.withUnsafeBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress,
                  let channelData = buffer.floatChannelData?.pointee else {
                return
            }
            memcpy(channelData, baseAddress, completeByteCount)
        }
        request.append(buffer)
    }

    request.endAudio()

    let timeoutSeconds = 12
    if transcriptionSemaphore.wait(timeout: .now() + .seconds(timeoutSeconds)) == .timedOut {
        task.cancel()
        stateLock.lock()
        let timedOutText = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
        let hadResult = sawAnyResult
        let timeoutTaskError = taskError
        stateLock.unlock()
        if !timedOutText.isEmpty || hadResult {
            emitLivePayload(
                LiveOutputPayload(
                    event: "final",
                    text: timedOutText,
                    language: language,
                    confidence: confidence,
                    isFinal: true
                )
            )
        } else if let timeoutTaskError {
            fail("macOS Speech live dictation timed out (\(timeoutTaskError)).")
        } else {
            fail("macOS Speech live dictation timed out.")
        }
    }

    task.cancel()

    stateLock.lock()
    let completedText = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
    let completedError = taskError
    let completedFinal = didFinish
    stateLock.unlock()

    if !completedFinal && completedText.isEmpty {
        fail("macOS Speech live dictation did not finish.")
    }

    if let completedError, completedText.isEmpty {
        fail("macOS Speech live dictation error: \(completedError)")
    }

    if completedText.isEmpty {
        fail("No speech recognized from live audio.")
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard !arguments.isEmpty else {
    fail("Usage: macos_speech_helper <audio_file_path> | --live --sample-rate <hz>")
}

if arguments.first == "--live" {
    guard let sampleRateIndex = arguments.firstIndex(of: "--sample-rate"),
          sampleRateIndex + 1 < arguments.count,
          let sampleRate = Double(arguments[sampleRateIndex + 1]),
          sampleRate > 0 else {
        fail("Usage: macos_speech_helper --live --sample-rate <hz>")
    }
    runLiveRecognition(sampleRate: sampleRate)
} else {
    runFileRecognition(inputPath: arguments[0])
}
