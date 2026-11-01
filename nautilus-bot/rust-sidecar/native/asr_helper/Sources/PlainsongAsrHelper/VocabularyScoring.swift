import Foundation

/// One way to say a vocabulary term, prepared once per term list: the written
/// term and each spoken form.
struct PreparedForm: Equatable, Sendable {
    let term: String
    let personalized: Bool
    /// The spoken form this was made from; nil for the written term.
    let alias: String?
    /// Lowercase letters and digits only, for the string shortlist.
    let letters: [UInt8]
    let sound: [UInt8]
    let words: Int
    /// CTC token sequences to try (with and without a leading word boundary).
    let tokens: [[Int]]
}

let undecomposedLetters: [Unicode.Scalar: String] = [
    "ł": "l", "Ł": "l", "đ": "d", "Đ": "d", "ð": "d", "Ð": "d", "ø": "o", "Ø": "o",
    "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe", "ß": "ss", "þ": "th", "Þ": "th",
    "ı": "i", "ŋ": "ng", "Ŋ": "ng",
]

/// Lowercase ASCII letters and digits of `text`; other characters dropped.
func matchLetters(_ text: String) -> [UInt8] {
    var out: [UInt8] = []
    for scalar in text.unicodeScalars {
        var value = scalar.value
        if value >= 65 && value <= 90 { value += 32 }
        if (value >= 97 && value <= 122) || (value >= 48 && value <= 57) {
            out.append(UInt8(value))
        } else if value > 127 {
            // Letters with no decomposition would otherwise vanish ("Łukasz"
            // as "ukasz", "Đà Nẵng" as "a nang"); the sidecar folds the same way.
            if let mapped = undecomposedLetters[scalar] {
                out += Array(mapped.utf8)
                continue
            }
            // Fold common Latin accents so "Begoña" matches "begona".
            let folded = String(scalar).folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
            for byte in folded.utf8 where (byte >= 97 && byte <= 122) { out.append(byte) }
        }
    }
    return out
}

/// 1 - edit distance / longer length.
func editSimilarity(_ a: [UInt8], _ b: [UInt8]) -> Double {
    if a.isEmpty || b.isEmpty { return 0 }
    var previous = Array(0...b.count)
    var current = [Int](repeating: 0, count: b.count + 1)
    for i in 1...a.count {
        current[0] = i
        for j in 1...b.count {
            let cost = a[i - 1] == b[j - 1] ? 0 : 1
            current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
        }
        swap(&previous, &current)
    }
    return 1 - Double(previous[b.count]) / Double(max(a.count, b.count))
}

/// A coarse key for English recognition and supplied pronunciation forms.
/// This only proposes candidates; it never authorizes a replacement.
func pronunciationKey(_ letters: [UInt8]) -> [UInt8] {
    var text = String(bytes: letters, encoding: .utf8) ?? ""
    for (from, to) in [("ph", "f"), ("sh", "x"), ("ch", "x"), ("th", "t"),
                       ("ck", "k"), ("qu", "k"), ("zh", "j")] {
        text = text.replacingOccurrences(of: from, with: to)
    }
    var out: [UInt8] = []
    for byte in text.utf8 {
        let sound: UInt8
        switch byte {
        case 97, 101, 105, 111, 117, 121, 104, 119: continue
        case 99, 113: sound = 107
        case 122: sound = 115
        case 118: sound = 102
        default: sound = byte
        }
        if out.last != sound { out.append(sound) }
    }
    return out
}

/// The written text without punctuation, for tokenizing.
func plainWords(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace })
        .map { $0.filter { $0.isLetter || $0.isNumber || $0 == "'" || $0 == "-" } }
        .filter { !$0.isEmpty }
        .joined(separator: " ")
}

/// Best CTC alignment score of `tokens` over every frame of `frames`: a
/// forced alignment with optional blanks at either end, so a term and the
/// transducer's words are compared over exactly the same audio.
func forcedAlignmentScore(_ frames: ArraySlice<[Float]>, tokens: [Int], blank: Int) -> Float {
    let n = tokens.count
    guard n > 0, !frames.isEmpty else { return -.infinity }
    let states = 2 * n + 1
    let negative = -Float.greatestFiniteMagnitude
    var previous = [Float](repeating: negative, count: states)
    var current = previous
    func symbol(_ state: Int) -> Int { state % 2 == 0 ? blank : tokens[state / 2] }
    var first = true
    for frame in frames {
        for state in 0..<states {
            let emit = symbol(state) < frame.count ? frame[symbol(state)] : negative
            var best: Float
            if first {
                best = state <= 1 ? 0 : negative
            } else {
                best = previous[state]
                if state >= 1 { best = max(best, previous[state - 1]) }
                if state >= 2 && state % 2 == 1 && tokens[state / 2] != tokens[state / 2 - 1] {
                    best = max(best, previous[state - 2])
                }
            }
            current[state] = best <= negative / 2 ? negative : best + emit
        }
        first = false
        swap(&previous, &current)
    }
    let end = max(previous[states - 1], previous[states - 2])
    return end <= negative / 2 ? -.infinity : end
}

/// Score every prepared pronunciation over the same audio span.
func bestPronunciation(_ forms: [PreparedForm], frames: ArraySlice<[Float]>, blank: Int)
    -> (form: PreparedForm, score: Float)? {
    var best: (form: PreparedForm, score: Float)?
    for form in forms {
        let score = form.tokens.map {
            forcedAlignmentScore(frames, tokens: $0, blank: blank)
        }.max() ?? -.infinity
        if score.isFinite, score > (best?.score ?? -.infinity) { best = (form, score) }
    }
    return best
}
