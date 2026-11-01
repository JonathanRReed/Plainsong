import Foundation

var checks = 0
func expect(_ value: @autoclosure () -> Bool, _ message: String) {
    guard value() else { fatalError(message) }
    checks += 1
}

let heard = pronunciationKey(matchLetters("Sarja"))
let supplied = pronunciationKey(matchLetters("seer sha"))
expect(editSimilarity(heard, supplied) > 0.66, "Pronunciation must propose the name")
expect(editSimilarity(matchLetters("Sarja"), matchLetters("seer sha")) < 0.5,
       "The spelling shortlist alone misses this pronunciation")
expect(editSimilarity(heard, pronunciationKey(matchLetters("Jonathan"))) < 0.5,
       "Unrelated names must not share a key")
expect(matchLetters("Łukasz Đà") == Array("lukaszda".utf8), "Keep undecomposed Latin letters")

func form(_ alias: String?, _ token: Int) -> PreparedForm {
    PreparedForm(term: "SyntheticName", personalized: true, alias: alias,
                 letters: matchLetters(alias ?? "SyntheticName"), sound: [], words: 1, tokens: [[token]])
}
let frames: [[Float]] = [[-5, -0.1, -4], [-5, -0.1, -4], [-5, -5, -0.1]]
let written = form(nil, 0)
let pronunciation = form("synthetic pronunciation", 1)
let best = bestPronunciation([written, pronunciation], frames: frames[...], blank: 2)
expect(best?.form.alias == pronunciation.alias, "Score the acoustic alias even when spelling selected the written form")
expect(best!.score > forcedAlignmentScore(frames[...], tokens: [0], blank: 2),
       "The winning pronunciation must fit the audio better")
expect(bestPronunciation([], frames: frames[...], blank: 2) == nil, "No forms means no correction")
expect(bestPronunciation([written], frames: [][...], blank: 2) == nil, "No audio means no correction")
let different: [[Float]] = [[-0.1, -5, -5], [-5, -0.1, -5]]
expect(forcedAlignmentScore(different[...], tokens: [0], blank: 2)
       < forcedAlignmentScore(different[...], tokens: [0, 1], blank: 2),
       "Alignment must account for the whole span")
print("Passed \(checks) Swift vocabulary checks")
