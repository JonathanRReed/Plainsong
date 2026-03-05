import Foundation
import Speech
import AVFoundation

struct OutputPayload: Codable {
    let text: String
    let language: String
    let confidence: Double
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count >= 2 else {
    fail("Usage: macos_speech_helper <audio_file_path>")
}

let inputPath = CommandLine.arguments[1]
let inputUrl = URL(fileURLWithPath: inputPath)
guard FileManager.default.fileExists(atPath: inputUrl.path) else {
    fail("Audio file does not exist: \(inputPath)")
}

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

let request = SFSpeechURLRecognitionRequest(url: inputUrl)
request.shouldReportPartialResults = true
request.taskHint = .dictation
if #available(macOS 10.15, *) {
    // Force on-device only when this recognizer explicitly supports it.
    // Otherwise allow standard recognition path to avoid false "no speech" failures.
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
    let candidate = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
    if !candidate.isEmpty {
        finalText = candidate
        let segments = result.bestTranscription.segments
        if !segments.isEmpty {
            let sum = segments.reduce(0.0) { partial, segment in
                partial + Double(segment.confidence)
            }
            confidence = sum / Double(segments.count)
        }
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

let payload = OutputPayload(text: completedText, language: language, confidence: confidence)
do {
    let encoder = JSONEncoder()
    encoder.outputFormatting = []
    let data = try encoder.encode(payload)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A])) // newline
} catch {
    fail("Failed to encode transcription payload: \(error.localizedDescription)")
}
