// plainsong-native-asr-helper
//
// Runs Parakeet TDT 0.6B (v3 multilingual or v2 English) through FluidAudio's
// Core ML build, for the Rust sidecar. The compute units come with each load:
// the Neural Engine on most Macs, the CPU on 8 GB Macs, where the Neural
// Engine's system wired memory (600-900 MiB, held outside this process) does
// not fit the memory budget. The sidecar owns capture, routing, fallback and
// the model files; this process only loads a verified model directory it is
// told about and turns 16 kHz mono samples into timed text.
//
// Protocol (version 3), all on stdio:
//
//   request   one JSON object per line on stdin
//   payload   `transcribe` is followed by exactly `sampleCount` little-endian
//             f32 samples (16 kHz mono) as raw bytes
//   response  one JSON object per line on stdout, in request order
//
//   {"op":"hello"}
//   {"op":"load","modelDir":"/abs/dir","family":"v3"|"v2","encoder":"int8"|"int8-v2",
//                "computeUnits":"cpuAndNeuralEngine"|"cpuOnly"}   // optional; default "cpuAndNeuralEngine"
//   {"op":"loadVocabularyModel","modelDir":"/abs/dir"}
//   {"op":"transcribe","sampleCount":N,"vocabulary":{"terms":[{"text":..,"spoken":[..]}]}}
//             + N*4 bytes; `vocabulary` is optional
//   {"op":"unloadVocabularyModel"}
//   {"op":"unload"}
//   {"op":"footprint"}
//
// Vocabulary evidence (version 2): with the small English CTC model loaded
// and a vocabulary in the request, the helper computes the CTC model's frame
// scores on the CPU while the transducer decodes (on the Neural Engine this
// model emits blank on nearly every frame) (as in NeMo's CTC word spotting,
// arXiv:2406.07096). Then, for each stretch of the transducer's words that is
// spelled like a term, it reports how well the term and the words themselves
// fit the same audio, and the CTC model's own spelling of it. The transcript
// itself is never rewritten here: the sidecar decides which candidates to
// apply, under its own fidelity rules, and shows them as changes the user
// can undo.
//
// Every response carries `"ok"`. A failure is `{"ok":false,"code":..,"message":..}`
// and leaves the helper running unless stdin closes. Nothing else is written
// to stdout; FluidAudio's own logging is confined to the unified log at
// warning level and above, so transcript text never reaches a console.

import CoreFoundation
import CoreML
import Darwin
import FluidAudio
import Foundation

let protocolVersion = 3
let engineVersion = "0.17.7"
/// Upper bound on one request's audio: 2 hours at 16 kHz. The sidecar sends
/// meeting chunks of 90 s and dictation of minutes at most; anything larger is
/// a framing error, and refusing it keeps a corrupt length from allocating
/// gigabytes.
let maxSampleCount = 16_000 * 60 * 120
/// A request line carries at most `maxVocabularyTerms` short terms.
let maxLineBytes = 192 * 1024
let maxVocabularyTerms = 512
let maxVocabularyTermChars = 64
let maxSpokenFormsPerTerm = 4

// MARK: - stdio

final class StdinReader {
    private var buffer: [UInt8] = []
    private var start = 0
    private var eof = false

    private func fill() -> Bool {
        if eof { return false }
        var chunk = [UInt8](repeating: 0, count: 256 * 1024)
        let count = chunk.withUnsafeMutableBytes { raw -> Int in
            while true {
                let n = Darwin.read(STDIN_FILENO, raw.baseAddress, raw.count)
                if n < 0 && errno == EINTR { continue }
                return n
            }
        }
        if count <= 0 {
            eof = true
            return false
        }
        if start > 0 && start == buffer.count {
            buffer.removeAll(keepingCapacity: true)
            start = 0
        } else if start > 1 << 20 {
            buffer.removeFirst(start)
            start = 0
        }
        buffer.append(contentsOf: chunk[0..<count])
        return true
    }

    /// The next line without its newline, or nil at end of input.
    func readLine() throws -> String? {
        while true {
            if let newline = buffer[start...].firstIndex(of: 0x0A) {
                guard newline - start <= maxLineBytes else {
                    throw HelperError("bad_request", "Request line is too long.")
                }
                let line = Array(buffer[start..<newline])
                start = newline + 1
                guard let text = String(bytes: line, encoding: .utf8) else {
                    throw HelperError("bad_request", "Request is not UTF-8.")
                }
                return text
            }
            if buffer.count - start > maxLineBytes {
                throw HelperError("bad_request", "Request line is too long.")
            }
            if !fill() {
                return nil
            }
        }
    }

    /// Exactly `count` bytes, or nil if input ends first.
    func readExact(_ count: Int) -> [UInt8]? {
        while buffer.count - start < count {
            if !fill() { return nil }
        }
        let bytes = Array(buffer[start..<(start + count)])
        start += count
        return bytes
    }
}

func writeResponse(_ object: [String: Any]) {
    guard
        var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    else {
        return
    }
    data.append(0x0A)
    data.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
            let n = Darwin.write(STDOUT_FILENO, raw.baseAddress! + offset, raw.count - offset)
            if n < 0 {
                if errno == EINTR { continue }
                exit(74)
            }
            offset += n
        }
    }
}

struct HelperError: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

/// Run async work to completion from the synchronous request loop. The loop
/// owns the main thread and the work runs on the cooperative pool, so the
/// wait cannot deadlock against it.
final class ResultBox<T>: @unchecked Sendable {
    var value: Result<T, Error>?
}

func runBlocking<T>(_ body: @escaping @Sendable () async throws -> T) throws -> T {
    let box = ResultBox<T>()
    let done = DispatchSemaphore(value: 0)
    Task.detached {
        do {
            box.value = .success(try await body())
        } catch {
            box.value = .failure(error)
        }
        done.signal()
    }
    done.wait()
    return try box.value!.get()
}

// MARK: - memory

func physFootprintBytes() -> UInt64? {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(
        MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let status = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
        }
    }
    return status == KERN_SUCCESS ? info.phys_footprint : nil
}

// MARK: - engine

final class Engine: @unchecked Sendable {
    private var manager: AsrManager?
    private var loadedKey: String?
    private var family: AsrModelVersion = .v3

    func load(modelDir: String, familyName: String, encoderName: String, unitsName: String) throws -> Int {
        let version: AsrModelVersion
        switch familyName {
        case "v3": version = .v3
        case "v2": version = .v2
        default: throw HelperError("bad_request", "Unknown model family '\(familyName)'.")
        }
        // `int8` is FluidAudio's default v3 encoder (`Encoder.mlmodelc`);
        // `int8-v2` is its per-channel int8 rebuild (`Encoder_v2.mlmodelc`).
        guard let precision = ParakeetEncoderPrecision(rawValue: encoderName),
            precision != .int4
        else {
            throw HelperError("bad_request", "Unknown encoder '\(encoderName)'.")
        }
        let units: MLComputeUnits
        switch unitsName {
        case "cpuAndNeuralEngine": units = .cpuAndNeuralEngine
        // On the CPU the model's ~1.2 GiB of weights stay clean file-backed
        // pages: nothing is wired, and the helper's own footprint stays tens
        // of MiB (measured 2026-10-25, ane-memory report). Decode is slower
        // (~2x) but word error is unchanged.
        case "cpuOnly": units = .cpuOnly
        default: throw HelperError("bad_request", "Unknown compute units '\(unitsName)'.")
        }
        // The compute units are part of the key: a model held with other
        // units is reloaded, not reused.
        let key = "\(familyName)|\(encoderName)|\(unitsName)|\(modelDir)"
        if loadedKey == key, manager != nil {
            return 0
        }
        unload()
        let directory = URL(fileURLWithPath: modelDir, isDirectory: true)
        // FluidAudio loads this optional graph when present. It is outside
        // Plainsong's pinned TDT model manifest, so never open it implicitly.
        guard !FileManager.default.fileExists(
            atPath: directory.appendingPathComponent("CtcHead.mlmodelc").path)
        else {
            throw HelperError("unverified_component", "The speech model folder contains an unverified optional component.")
        }
        let started = Date()
        let manager = try runBlocking { () -> AsrManager in
            // The sidecar picks the compute units from the Mac's memory tier;
            // the preprocessor is CPU-only inside FluidAudio either way. The
            // int8 encoder is the library default for v3 (`Encoder.mlmodelc`).
            let configuration = AsrModels.defaultConfiguration()
            configuration.computeUnits = units
            let models = try AsrModels.loadLocal(
                from: directory, version: version, configuration: configuration,
                encoderPrecision: precision, encoderComputeUnits: units)
            // One chunk at a time: the meeting and dictation callers send one
            // request at a time anyway, and every parallel worker would hold
            // its own scratch buffers.
            let config = ASRConfig(
                tdtConfig: TdtConfig(blankId: version.blankId),
                encoderHiddenSize: version.encoderHiddenSize,
                parallelChunkConcurrency: 1
            )
            let manager = AsrManager(config: config)
            try await manager.loadModels(models)
            return manager
        }
        // A first decode pays one-time costs (on the Neural Engine route the
        // program compile for this shape); doing it here keeps that cost out
        // of the first dictation.
        let warmup = [Float](repeating: 0, count: 16_000)
        _ = try runBlocking {
            var state = TdtDecoderState.make(decoderLayers: 2)
            return try await manager.transcribe(warmup, decoderState: &state)
        }
        self.manager = manager
        self.loadedKey = key
        self.family = version
        return Int(Date().timeIntervalSince(started) * 1000)
    }

    func unload() {
        if let manager {
            _ = try? runBlocking {
                await manager.cleanup()
            }
        }
        manager = nil
        loadedKey = nil
    }

    func transcribe(_ samples: [Float], vocabulary: [VocabularyRequestTerm]?, diagnosticTerms: [String] = []) throws -> [String: Any] {
        guard samples.allSatisfy({ $0.isFinite }) else {
            throw HelperError("bad_audio", "Audio contains a non-finite sample.")
        }
        guard let manager else {
            throw HelperError("not_loaded", "No speech model is loaded.")
        }
        let minimum = ASRConstants.minimumRequiredSamples(forSampleRate: 16_000)
        var audio = samples
        if audio.count < minimum {
            audio.append(contentsOf: [Float](repeating: 0, count: minimum - audio.count))
        }
        let started = Date()
        let input = audio
        let booster = vocabulary.flatMap { $0.isEmpty ? nil : vocabularyEngine }
        let requested = vocabulary ?? []
        // The acoustic scoring runs beside the decode, not after it: only the
        // final comparison, which needs the decoder's word timings, waits.
        let (result, evidence) = try runBlocking { () -> (ASRResult, VocabularyEvidence?) in
            async let decoded: ASRResult = {
                var state = TdtDecoderState.make(decoderLayers: 2)
                return try await manager.transcribe(input, decoderState: &state)
            }()
            async let scored: VocabularyEngine.Scored? = {
                guard let booster else { return nil }
                return try? await booster.score(input, terms: requested)
            }()
            let result = try await decoded
            guard let scored = await scored, let booster else { return (result, nil) }
            return (result, booster.evaluate(result, scored: scored, diagnosticTerms: diagnosticTerms))
        }
        let processingMs = Int(Date().timeIntervalSince(started) * 1000)
        let words = groupWords(result.tokenTimings ?? [])
        var response: [String: Any] = [
            "text": result.text,
            "words": words,
            "durationS": Double(samples.count) / 16_000.0,
            "processingMs": processingMs,
            "confidence": Double(result.confidence),
        ]
        if let vocabulary, !vocabulary.isEmpty {
            if let evidence {
                response["vocabulary"] = evidence.json
            } else {
                response["vocabulary"] = [
                    "available": false,
                    "reason": vocabularyEngine == nil ? "not_loaded" : "scoring_failed",
                ]
            }
        }
        return response
    }

    // MARK: vocabulary model

    private var vocabularyEngine: VocabularyEngine?
    private var vocabularyModelDir: String?

    func loadVocabularyModel(modelDir: String) throws -> Int {
        if vocabularyModelDir == modelDir, vocabularyEngine != nil {
            return 0
        }
        unloadVocabularyModel()
        let started = Date()
        let directory = URL(fileURLWithPath: modelDir, isDirectory: true)
        let engine = try runBlocking { try await VocabularyEngine.load(from: directory) }
        vocabularyEngine = engine
        vocabularyModelDir = modelDir
        return Int(Date().timeIntervalSince(started) * 1000)
    }

    func unloadVocabularyModel() {
        vocabularyEngine = nil
        vocabularyModelDir = nil
    }
}

// MARK: - vocabulary evidence

struct VocabularyRequestTerm: Equatable, Sendable {
    let text: String
    let personalized: Bool
    /// Plain-English respellings of how the term is said ("shi-vawn" for
    /// Siobhan). Each is scored against the audio as another way to say the
    /// same term, and offered to the string matcher as an alias.
    let spoken: [String]

    static func parse(_ value: Any?) throws -> [VocabularyRequestTerm]? {
        guard let value else { return nil }
        guard let object = value as? [String: Any], let rows = object["terms"] as? [Any] else {
            throw HelperError("bad_request", "vocabulary needs a terms list.")
        }
        guard rows.count <= maxVocabularyTerms else {
            throw HelperError("bad_request", "vocabulary has too many terms.")
        }
        return try rows.map { row in
            guard let row = row as? [String: Any], let text = row["text"] as? String,
                !text.trimmingCharacters(in: .whitespaces).isEmpty,
                text.count <= maxVocabularyTermChars
            else {
                throw HelperError("bad_request", "vocabulary term is not valid.")
            }
            let spoken = (row["spoken"] as? [Any] ?? []).compactMap { $0 as? String }
                .filter { !$0.isEmpty && $0.count <= maxVocabularyTermChars }
            guard spoken.count <= maxSpokenFormsPerTerm else {
                throw HelperError("bad_request", "vocabulary term has too many spoken forms.")
            }
            return VocabularyRequestTerm(text: text, personalized: row["personalized"] as? Bool ?? false, spoken: spoken)
        }
    }
}

/// Frame log-probabilities from the CTC model, computed the way FluidAudio's
/// keyword spotter computes them (15 s windows, 2 s overlap merged in
/// probability space, log-softmax with its temperature and blank bias) but
/// copying buffers directly instead of boxing every value, and converting only
/// the frames that hold audio. The spotter's element-by-element path costs
/// about 100 ms per window, which would land on every dictation's stop path.
enum CtcLogProbs {
    static let windowSamples = 240_000
    static let overlapSamples = 32_000

    static func compute(_ samples: [Float], models: CtcModels) throws -> ([[Float]], Double) {
        guard !samples.isEmpty else { return ([], 0) }
        let blankId = models.vocabulary.count
        if samples.count <= windowSamples {
            return try window(samples[...], models: models, blankId: blankId)
        }
        var merged: [[Float]] = []
        var frameDuration = 0.0
        var start = 0
        var first = true
        while start < samples.count {
            let end = min(start + windowSamples, samples.count)
            let (frames, duration) = try window(samples[start..<end], models: models, blankId: blankId)
            if first {
                frameDuration = duration
                merged = frames
                first = false
            } else if frameDuration > 0 {
                let overlapFrames = Int(Double(overlapSamples) / 16_000.0 / frameDuration)
                let overlap = min(overlapFrames, merged.count, frames.count)
                let base = merged.count - overlap
                for index in 0..<overlap {
                    merged[base + index] = mergeFrame(merged[base + index], frames[index])
                }
                if overlap < frames.count {
                    merged.append(contentsOf: frames[overlap...])
                }
            }
            if end >= samples.count { break }
            start += windowSamples - overlapSamples
        }
        return (merged, frameDuration)
    }

    private static func mergeFrame(_ a: [Float], _ b: [Float]) -> [Float] {
        let count = min(a.count, b.count)
        var out = [Float](repeating: 0, count: count)
        for j in 0..<count {
            let m = max(a[j], b[j])
            out[j] = m == -.infinity ? -.infinity : m + logf(expf(a[j] - m) + expf(b[j] - m)) - 0.693_147_18
        }
        return out
    }

    private static func window(
        _ samples: ArraySlice<Float>, models: CtcModels, blankId: Int
    ) throws -> ([[Float]], Double) {
        let count = min(samples.count, windowSamples)
        let description = models.melSpectrogram.modelDescription.inputDescriptionsByName["audio"]
        let rank = description?.multiArrayConstraint?.shape.count ?? 1
        let half = description?.multiArrayConstraint?.dataType == .float16
        let shape: [NSNumber] = rank == 2 ? [1, NSNumber(value: windowSamples)] : [NSNumber(value: windowSamples)]
        let audio = try MLMultiArray(shape: shape, dataType: half ? .float16 : .float32)
        audio.withUnsafeMutableBytes { bytes, _ in
            bytes.initializeMemory(as: UInt8.self, repeating: 0)
            if half {
                let out = bytes.bindMemory(to: Float16.self)
                for (offset, value) in samples.prefix(count).enumerated() { out[offset] = Float16(value) }
            } else {
                let out = bytes.bindMemory(to: Float.self)
                for (offset, value) in samples.prefix(count).enumerated() { out[offset] = value }
            }
        }
        let audioLength = try MLMultiArray(shape: [1], dataType: .int32)
        audioLength[0] = NSNumber(value: count)
        let options = MLPredictionOptions()
        let mel = try models.melSpectrogram.prediction(
            from: MLDictionaryFeatureProvider(dictionary: [
                "audio": MLFeatureValue(multiArray: audio),
                "audio_length": MLFeatureValue(multiArray: audioLength),
            ]),
            options: options)
        guard let features = mel.featureValue(for: "melspectrogram_features")?.multiArrayValue else {
            throw HelperError("vocabulary_model", "The vocabulary model returned no features.")
        }
        var melLength = mel.featureValue(for: "mel_length")?.multiArrayValue?[0].intValue
            ?? features.shape.last?.intValue ?? 0
        if features.shape.count == 4 { melLength = features.shape[2].intValue }
        guard melLength > 0 else {
            throw HelperError("vocabulary_model", "The vocabulary model returned empty features.")
        }
        let melLengthArray = try MLMultiArray(shape: [1], dataType: .int32)
        melLengthArray[0] = NSNumber(value: melLength)
        var inputs: [String: MLFeatureValue] = [
            "melspectrogram_features": MLFeatureValue(multiArray: features),
            "mel_length": MLFeatureValue(multiArray: melLengthArray),
        ]
        if let flag = try? MLMultiArray(shape: [1, 1, 1, 1], dataType: .float16) {
            flag[0] = 1
            inputs["input_1"] = MLFeatureValue(multiArray: flag)
        }
        let encoded = try models.encoder.prediction(
            from: MLDictionaryFeatureProvider(dictionary: inputs), options: options)
        // Raw logits, not the softmax output: the spotter's own note is that a
        // second log-softmax over probabilities gives meaningless scores.
        guard let logits = encoded.featureValue(for: "ctc_head_raw_output")?.multiArrayValue
            ?? encoded.featureValue(for: "ctc_head_output")?.multiArrayValue
        else {
            throw HelperError("vocabulary_model", "The vocabulary model returned no scores.")
        }
        let dims = logits.shape.map(\.intValue)
        let strides = logits.strides.map(\.intValue)
        let timeAxis: Int
        let vocabAxis: Int
        switch dims.count {
        case 3: (timeAxis, vocabAxis) = (1, 2)
        case 4: (timeAxis, vocabAxis) = (3, 1)
        default: throw HelperError("vocabulary_model", "The vocabulary model returned an unexpected shape.")
        }
        let totalFrames = dims[timeAxis]
        let vocabSize = dims[vocabAxis]
        guard totalFrames > 0, vocabSize > 0 else { return ([], 0) }
        let frames: Int
        if count >= windowSamples {
            frames = totalFrames
        } else {
            let samplesPerFrame = Double(windowSamples) / Double(totalFrames)
            frames = max(1, min(Int(ceil(Double(count) / samplesPerFrame)), totalFrames))
        }
        let timeStride = strides[timeAxis]
        let vocabStride = strides[vocabAxis]
        let temperature = ContextBiasingConstants.ctcTemperature
        let blankBias = ContextBiasingConstants.blankBias
        var rows: [[Float]] = []
        rows.reserveCapacity(frames)
        try logits.withUnsafeBytes { bytes in
            let read: (Int) -> Float
            switch logits.dataType {
            case .float32:
                let values = bytes.bindMemory(to: Float.self)
                read = { values[$0] }
            case .float16:
                let values = bytes.bindMemory(to: Float16.self)
                read = { Float(values[$0]) }
            default:
                throw HelperError("vocabulary_model", "The vocabulary model returned an unexpected type.")
            }
            var row = [Float](repeating: 0, count: vocabSize)
            for t in 0..<frames {
                var peak = -Float.infinity
                for v in 0..<vocabSize {
                    let value = read(t * timeStride + v * vocabStride) / temperature
                    row[v] = value
                    if value > peak { peak = value }
                }
                var sum: Float = 0
                for v in 0..<vocabSize { sum += expf(row[v] - peak) }
                let normalizer = peak + logf(sum)
                for v in 0..<vocabSize { row[v] -= normalizer }
                if blankBias != 0, blankId < vocabSize { row[blankId] -= blankBias }
                rows.append(row)
            }
        }
        let frameDuration = Double(count) / Double(frames) / 16_000.0
        return (rows, frameDuration)
    }
}

struct VocabularyEvidence {
    let json: [String: Any]
}

/// The CTC model (Parakeet CTC 110M, English) and its tokenizer, loaded only
/// from a directory the sidecar verified. The prepared forms of the last term
/// list are kept, so repeated dictations with the same terms skip tokenizing.
///
/// FluidAudio's own rescorer is not used: its string matching costs about
/// 0.3 ms per term per dictation (89 ms for 277 terms) and it re-reads the
/// tokenizer from disk whenever a rescorer is made. Here a byte-level
/// shortlist picks the few terms worth scoring, and each is compared with
/// the transducer's words by a forced alignment over the same frames.
final class VocabularyEngine: @unchecked Sendable {
    let directory: URL
    let models: CtcModels
    let tokenizer: CtcTokenizer
    private let lock = NSLock()
    private var cached: (terms: [VocabularyRequestTerm], forms: [PreparedForm])?

    /// Shortlist floor on spelling similarity, and how many terms are scored
    /// for one stretch of words.
    static let minSimilarity = 0.5
    static let termsPerSpan = 3
    static let extraTermsPerSpan = 3
    /// Audio after the transducer's last word time that the comparison and
    /// the CTC spelling include. The CTC model emits a word's tokens inside
    /// or just after the transducer's span for it, never before, so any lead
    /// would pull in the previous word.
    static let tailSeconds = 0.08

    struct Scored: Sendable {
        let logProbs: [[Float]]
        let frameDuration: Double
        let forms: [PreparedForm]
        let termCount: Int
        let ctcMs: Int
        let prepared: Bool
    }

    private init(directory: URL, models: CtcModels, tokenizer: CtcTokenizer) {
        self.directory = directory
        self.models = models
        self.tokenizer = tokenizer
    }

    static func load(from directory: URL) async throws -> VocabularyEngine {
        // Only the two graphs, the vocabulary and the tokenizer the sidecar
        // pinned. The head-only graph some exports ship beside them is not
        // part of that pin.
        guard !FileManager.default.fileExists(
            atPath: directory.appendingPathComponent("CtcHead.mlmodelc").path)
        else {
            throw HelperError("unverified_component", "The vocabulary model folder contains an unverified optional component.")
        }
        // CPU only. On the Neural Engine this export's CTC head emits blank on
        // nearly every frame (FluidAudio's own path does the same), so every
        // score is noise; CPU and GPU agree with each other. CPU runs beside the
        // transducer on the Neural Engine and adds about 12 MB, where the GPU
        // adds over 200 MB.
        let config = MLModelConfiguration()
        config.computeUnits = .cpuOnly
        let vocabularyData = try Data(contentsOf: directory.appendingPathComponent("vocab.json"))
        var vocabulary: [Int: String] = [:]
        for (key, value) in (try JSONSerialization.jsonObject(with: vocabularyData) as? [String: String]) ?? [:] {
            if let id = Int(key) { vocabulary[id] = value }
        }
        guard !vocabulary.isEmpty else {
            throw HelperError("vocabulary_model", "The vocabulary model has no token list.")
        }
        let models = CtcModels(
            melSpectrogram: try MLModel(
                contentsOf: directory.appendingPathComponent("MelSpectrogram.mlmodelc"), configuration: config),
            encoder: try MLModel(
                contentsOf: directory.appendingPathComponent("AudioEncoder.mlmodelc"), configuration: config),
            configuration: config, vocabulary: vocabulary, variant: .ctc110m)
        let tokenizer = try await CtcTokenizer.load(from: directory)
        // Run once now so the first dictation does not pay for model setup.
        _ = try CtcLogProbs.compute([Float](repeating: 0, count: 16_000), models: models)
        return VocabularyEngine(directory: directory, models: models, tokenizer: tokenizer)
    }

    private func forms(for terms: [VocabularyRequestTerm]) -> ([PreparedForm], Bool) {
        lock.lock()
        if let cached, cached.terms == terms {
            lock.unlock()
            return (cached.forms, false)
        }
        lock.unlock()
        var forms: [PreparedForm] = []
        for term in terms {
            let written = plainWords(term.text)
            let variants = tokenizer.encodeVariants(written).filter { !$0.isEmpty }
            let letters = matchLetters(term.text)
            if !variants.isEmpty && !letters.isEmpty {
                forms.append(PreparedForm(
                    term: term.text, personalized: term.personalized, alias: nil, letters: letters, sound: pronunciationKey(letters),
                    words: max(1, written.split(separator: " ").count), tokens: variants))
            }
            for spoken in term.spoken {
                let plain = plainWords(spoken)
                let ids = tokenizer.encodeVariants(plain).filter { !$0.isEmpty }
                let spokenLetters = matchLetters(spoken)
                if !ids.isEmpty && !spokenLetters.isEmpty {
                    forms.append(PreparedForm(
                        term: term.text, personalized: term.personalized, alias: spoken, letters: spokenLetters, sound: pronunciationKey(spokenLetters),
                        words: max(1, (term.personalized ? written : plain).split(separator: " ").count), tokens: ids))
                }
            }
        }
        lock.lock()
        cached = (terms, forms)
        lock.unlock()
        return (forms, true)
    }

    func score(_ samples: [Float], terms: [VocabularyRequestTerm]) async throws -> Scored {
        let started = Date()
        let (forms, fresh) = forms(for: terms)
        let (logProbs, frameDuration) = try CtcLogProbs.compute(samples, models: models)
        return Scored(
            logProbs: logProbs, frameDuration: frameDuration, forms: forms,
            termCount: terms.count, ctcMs: Int(Date().timeIntervalSince(started) * 1000),
            prepared: fresh)
    }

    func evaluate(_ result: ASRResult, scored: Scored, diagnosticTerms: [String] = []) -> VocabularyEvidence {
        let started = Date()
        let words = groupWords(result.tokenTimings ?? [])
        let textWords = result.text.split(whereSeparator: { $0.isWhitespace })
        guard !scored.logProbs.isEmpty, scored.frameDuration > 0, !words.isEmpty,
            words.count == textWords.count
        else {
            return VocabularyEvidence(json: [
                "available": true, "candidates": [], "ctcMs": scored.ctcMs, "rescoreMs": 0,
                "terms": scored.termCount,
            ])
        }
        let blank = models.vocabulary.count
        let formsByTerm = Dictionary(grouping: scored.forms, by: \.term)
        var termOrder: [String: Int] = [:]
        for (index, form) in scored.forms.enumerated() where termOrder[form.term] == nil {
            termOrder[form.term] = index
        }
        let wordLetters = words.map { matchLetters(($0["text"] as? String) ?? "") }
        var candidates: [[String: Any]] = []
        var diagnostics: [[String: Any]] = []
        let diagnosticForms = scored.forms.filter { diagnosticTerms.contains($0.term) }
        var evaluated = 0
        let maxSpan = min(4, words.count)
        for start in 0..<words.count {
            for length in 1...maxSpan where start + length <= words.count {
                var heard: [UInt8] = []
                for index in start..<(start + length) { heard += wordLetters[index] }
                if heard.isEmpty { continue }
                // An already requested spelling stays intact.
                if scored.forms.contains(where: { $0.alias == nil && $0.letters == heard }) { continue }
                guard let startMs = words[start]["startMs"] as? Int,
                    let endMs = words[start + length - 1]["endMs"] as? Int
                else { continue }
                let firstFrame = max(0, Int((Double(startMs) / 1000) / scored.frameDuration))
                let lastFrame = min(
                    scored.logProbs.count,
                    Int(((Double(endMs) / 1000) + Self.tailSeconds) / scored.frameDuration) + 1)
                guard firstFrame < lastFrame else { continue }
                let frames = scored.logProbs[firstFrame..<lastFrame]
                var greedy: Float = 0
                for frame in frames { greedy += frame.max() ?? 0 }
                let count = Float(frames.count)
                let spelling = greedySpelling(frames, blank: blank)
                let acousticLetters = matchLetters(spelling)
                let heardSound = pronunciationKey(heard)
                // Keep the original spelling shortlist, then add a bounded
                // shortlist from pronunciations and the CTC recognizer itself.
                var lexical: [String: Double] = [:]
                var lexicalForms: [String: PreparedForm] = [:]
                var alternate: [String: Double] = [:]
                var similarities: [String: Double] = [:]
                for form in scored.forms {
                    if form.personalized {
                        if length > 3 || abs(form.words - length) > 2 { continue }
                    } else if abs(form.words - length) > 1 { continue }
                    let ratio = Double(form.letters.count) / Double(heard.count)
                    let lexicalEligible = ratio >= 0.6 && ratio <= 1.67
                    let soundEligible = form.personalized && ratio >= 0.45 && ratio <= 2.2
                        && heardSound.count >= 3 && form.sound.count >= 3
                    let acousticRatio = acousticLetters.isEmpty ? 0
                        : Double(form.letters.count) / Double(acousticLetters.count)
                    let acousticEligible = form.personalized && acousticRatio >= 0.6 && acousticRatio <= 1.67
                    // Length checks avoid edit-distance work on unrelated
                    // terms. Built-ins retain their original spelling filter.
                    if !lexicalEligible && !soundEligible && !acousticEligible { continue }
                    let similarity = editSimilarity(form.letters, heard)
                    if form.personalized {
                        similarities[form.term] = max(similarities[form.term] ?? 0, similarity)
                    }
                    if lexicalEligible, similarity >= Self.minSimilarity {
                        if similarity > (lexical[form.term] ?? -1) {
                            lexical[form.term] = similarity
                            lexicalForms[form.term] = form
                        }
                    }
                    let phonetic = soundEligible ? editSimilarity(form.sound, heardSound) : 0
                    let acoustic = acousticEligible ? editSimilarity(form.letters, acousticLetters) : 0
                    if phonetic >= 0.66 || acoustic >= 0.6 {
                        alternate[form.term] = max(alternate[form.term] ?? 0, max(phonetic, acoustic))
                    }
                }
                func ranked(_ values: [String: Double]) -> [String] {
                    values.keys.sorted { a, b in
                        if values[a] != values[b] { return values[a]! > values[b]! }
                        return (termOrder[a] ?? 0) < (termOrder[b] ?? 0)
                    }
                }
                var selected = Array(ranked(lexical).prefix(Self.termsPerSpan))
                selected += ranked(alternate).filter { !selected.contains($0) }.prefix(Self.extraTermsPerSpan)
                guard !selected.isEmpty || !diagnosticForms.isEmpty else { continue }
                let heardPhrase = textWords[start..<(start + length)].joined(separator: " ")
                let heardTokens = tokenizer.encodeVariants(plainWords(heardPhrase)).filter { !$0.isEmpty }
                let heardScore = heardTokens.map {
                    forcedAlignmentScore(frames, tokens: $0, blank: blank)
                }.max() ?? -.infinity
                for term in selected {
                    // Spelling chooses the term, not its pronunciation. Score
                    // every supplied form over the same frames and keep the best.
                    let allForms = formsByTerm[term] ?? []
                    let forms = allForms.first?.personalized == true
                        ? allForms : lexicalForms[term].map { [$0] } ?? []
                    evaluated += forms.count
                    guard let best = bestPronunciation(forms, frames: frames, blank: blank),
                        heardScore.isFinite else { continue }
                    let form = best.form
                    let termScore = best.score
                    var row: [String: Any] = [
                        "term": form.term, "phrase": heardPhrase,
                        "wordStart": start, "wordEnd": start + length,
                        "similarity": form.personalized ? similarities[term] ?? 0 : lexical[term] ?? 0,
                        "termScore": Double(termScore / count),
                        "originalScore": Double(heardScore / count),
                        "bestPathScore": Double(greedy / count),
                        "frames": frames.count, "ctcHeard": spelling,
                    ]
                    if let alias = form.alias { row["alias"] = alias }
                    candidates.append(row)
                }
                // Explicit evaluation requests only. No trace is persisted by the helper.
                for form in diagnosticForms {
                    let score = form.tokens.map {
                        forcedAlignmentScore(frames, tokens: $0, blank: blank)
                    }.max() ?? -.infinity
                    guard score.isFinite, heardScore.isFinite else { continue }
                    diagnostics.append([
                        "term": form.term, "alias": form.alias ?? "", "phrase": heardPhrase,
                        "wordStart": start, "wordEnd": start + length,
                        "firstFrame": firstFrame, "lastFrame": lastFrame,
                        "similarity": editSimilarity(form.letters, heard),
                        "shortlisted": selected.contains(form.term),
                        "termScore": Double(score / count), "originalScore": Double(heardScore / count),
                        "ctcHeard": spelling,
                    ])
                }
            }
        }
        return VocabularyEvidence(json: [
            "available": true,
            "candidates": candidates,
            "evaluated": evaluated,
            "diagnostics": diagnostics,
            "ctcMs": scored.ctcMs,
            "rescoreMs": Int(Date().timeIntervalSince(started) * 1000),
            "prepared": scored.prepared,
            "terms": scored.termCount,
        ])
    }

    /// The CTC model's own best-path spelling of these frames: a second
    /// recognizer's opinion of the words the transducer wrote there.
    func greedySpelling(_ frames: ArraySlice<[Float]>, blank: Int) -> String {
        var previous = -1
        var text = ""
        for frame in frames {
            var best = 0
            var bestScore = -Float.infinity
            for (index, value) in frame.enumerated() where value > bestScore {
                best = index
                bestScore = value
            }
            if best != previous, best != blank, let piece = models.vocabulary[best] {
                text += piece.replacingOccurrences(of: "\u{2581}", with: " ")
            }
            previous = best
        }
        return text.trimmingCharacters(in: .whitespaces)
    }
}

/// Group SentencePiece tokens into words on their boundary marker, keeping
/// each word's first start, last end and mean token confidence. Times are
/// milliseconds from the start of the request's audio.
func groupWords(_ timings: [TokenTiming]) -> [[String: Any]] {
    var words: [[String: Any]] = []
    var text = ""
    var startMs = 0
    var endMs = 0
    var confidenceSum = 0.0
    var tokens = 0

    func flush() {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty {
            words.append([
                "text": trimmed,
                "startMs": startMs,
                "endMs": max(endMs, startMs),
                "confidence": tokens > 0 ? confidenceSum / Double(tokens) : 0,
            ])
        }
        text = ""
        confidenceSum = 0
        tokens = 0
    }

    for timing in timings {
        let piece = timing.token
        if piece.isEmpty || piece == "<blank>" || piece == "<pad>" || piece.hasPrefix("<|") {
            continue
        }
        let startsWord = piece.hasPrefix("\u{2581}") || piece.hasPrefix(" ")
        if startsWord || text.isEmpty {
            if !text.isEmpty { flush() }
            startMs = Int((timing.startTime * 1000).rounded())
        }
        text += piece.replacingOccurrences(of: "\u{2581}", with: " ")
        endMs = Int((timing.endTime * 1000).rounded())
        confidenceSum += Double(timing.confidence)
        tokens += 1
    }
    flush()
    return words
}

// MARK: - request loop

AppLogger.defaultSubsystem = "app.plainsong.asr-helper"
AppLogger.minimumLevel = .warning
AppLogger.mirrorsToConsole = false
signal(SIGPIPE, SIG_IGN)

// A compile can keep the main thread away from stdin for minutes, so a closed
// stdin is not noticed when the sidecar dies; nothing else would end this
// process. `_exit`: the main thread may be inside Core ML, and exit handlers
// must not wait on it.
let parentPid = getppid()
let parentWatch = DispatchSource.makeProcessSource(
    identifier: parentPid, eventMask: .exit, queue: .global(qos: .utility))
parentWatch.setEventHandler { _exit(0) }
parentWatch.resume()
// Registered too late to see an exit that already happened.
if parentPid == 1 || getppid() != parentPid { _exit(0) }

let reader = StdinReader()
let engine = Engine()

func failure(_ op: String, _ error: Error) -> [String: Any] {
    if let error = error as? HelperError {
        return ["op": op, "ok": false, "code": error.code, "message": error.message]
    }
    return [
        "op": op, "ok": false, "code": "engine_error",
        "message": String(describing: error).prefix(400).description,
    ]
}

while true {
    let line: String?
    do {
        line = try reader.readLine()
    } catch {
        writeResponse(failure("unknown", error))
        exit(65)
    }
    guard let line else { break }
    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
    guard
        let data = line.data(using: .utf8),
        let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let op = request["op"] as? String
    else {
        writeResponse(failure("unknown", HelperError("bad_request", "Request is not a JSON object with an op.")))
        exit(65)
    }

    switch op {
    case "hello":
        writeResponse([
            "op": op, "ok": true, "protocolVersion": protocolVersion,
            "engine": "fluidaudio", "engineVersion": engineVersion,
            "capabilities": ["vocabulary"],
        ])
    case "load":
        guard let modelDir = request["modelDir"] as? String,
            let family = request["family"] as? String
        else {
            writeResponse(failure(op, HelperError("bad_request", "load needs modelDir and family.")))
            continue
        }
        do {
            let encoder = request["encoder"] as? String ?? "int8"
            // Version 2 sidecars never sent computeUnits; the route's
            // long-standing behaviour is the Neural Engine.
            let units = request["computeUnits"] as? String ?? "cpuAndNeuralEngine"
            let loadMs = try engine.load(
                modelDir: modelDir, familyName: family, encoderName: encoder, unitsName: units)
            var response: [String: Any] = ["op": op, "ok": true, "loadMs": loadMs]
            if let bytes = physFootprintBytes() { response["physFootprintBytes"] = bytes }
            writeResponse(response)
        } catch {
            writeResponse(failure(op, error))
        }
    case "transcribe":
        guard let number = request["sampleCount"] as? NSNumber,
            CFGetTypeID(number) != CFBooleanGetTypeID(),
            number.doubleValue >= 0, number.doubleValue <= Double(maxSampleCount),
            number.doubleValue.rounded(.towardZero) == number.doubleValue
        else {
            writeResponse(failure(op, HelperError("bad_request", "transcribe needs a valid sampleCount.")))
            exit(65)
        }
        let count = number.intValue
        guard let bytes = reader.readExact(count * 4) else { exit(0) }
        var samples = [Float](repeating: 0, count: count)
        samples.withUnsafeMutableBytes { raw in
            bytes.withUnsafeBytes { source in
                raw.copyMemory(from: source)
            }
        }
        do {
            // Parsed after the payload is consumed, so a bad vocabulary fails
            // this request without desynchronizing the pipe.
            let vocabulary = try VocabularyRequestTerm.parse(request["vocabulary"])
            let diagnosticTerms = (request["vocabularyDiagnostics"] as? [String] ?? [])
                .prefix(maxVocabularyTerms).filter { $0.count <= maxVocabularyTermChars }
            var response = try engine.transcribe(samples, vocabulary: vocabulary, diagnosticTerms: Array(diagnosticTerms))
            response["op"] = op
            response["ok"] = true
            writeResponse(response)
        } catch {
            writeResponse(failure(op, error))
        }
    case "loadVocabularyModel":
        guard let modelDir = request["modelDir"] as? String else {
            writeResponse(failure(op, HelperError("bad_request", "loadVocabularyModel needs modelDir.")))
            continue
        }
        do {
            let loadMs = try engine.loadVocabularyModel(modelDir: modelDir)
            var response: [String: Any] = ["op": op, "ok": true, "loadMs": loadMs]
            if let bytes = physFootprintBytes() { response["physFootprintBytes"] = bytes }
            writeResponse(response)
        } catch {
            writeResponse(failure(op, error))
        }
    case "unloadVocabularyModel":
        engine.unloadVocabularyModel()
        writeResponse(["op": op, "ok": true])
    case "unload":
        engine.unload()
        writeResponse(["op": op, "ok": true])
    case "footprint":
        var response: [String: Any] = ["op": op, "ok": true]
        if let bytes = physFootprintBytes() { response["physFootprintBytes"] = bytes }
        writeResponse(response)
    default:
        writeResponse(failure(op, HelperError("bad_request", "Unknown op '\(op)'.")))
    }
}
engine.unload()
exit(0)
