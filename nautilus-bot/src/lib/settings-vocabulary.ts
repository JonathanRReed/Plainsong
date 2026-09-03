/**
 * The words the settings surface is allowed to use, and what each one means.
 *
 * The complaint this exists to answer: "things having multiple meanings, which
 * is confusing." Settings had grown four vocabularies -- one per subsystem --
 * so "mode", "model", "provider" and "local" each named two or three different
 * things depending on which tab you were on.
 *
 * This list is the contract, and `src/__tests__/settings-vocabulary.test.ts`
 * enforces it two ways:
 *
 *   1. No term may appear under two concepts. Adding "route" as a second name
 *      for the speech engine fails the test at the list, before anyone renders
 *      it.
 *   2. No retired phrase may appear in a settings-surface source file. That is
 *      the half with teeth: it fails when someone writes "custom mode" into a
 *      new description months from now.
 *
 * The doc that goes with it is `docs/settings-inventory-2026-09-03.md`.
 */

/** One settled word, and the single thing it is allowed to mean. */
export interface VocabularyTerm {
  /** The word or phrase as a reader sees it, lowercased. */
  term: string;
  /** A stable id for the thing it names. Two terms may not share a concept. */
  concept: string;
  /** What that concept is, in one sentence, for the next person. */
  means: string;
}

/**
 * Every settled term. One row per word; the concept is the key that has to be
 * unique in the other direction too -- two words for one concept is the same
 * failure as one word for two concepts, just quieter.
 */
export const SETTINGS_VOCABULARY: readonly VocabularyTerm[] = [
  {
    term: "profile",
    concept: "dictation-profile",
    means:
      "A saved bundle of dictation style, context source and delivery. Stored as `dictationCustomModes` and selected by `dictationModePreset`.",
  },
  {
    term: "speech engine",
    concept: "speech-engine",
    means:
      "The thing that turns speech into text: `dictationProvider`/`dictationModelId` for dictation, `meetingProvider`/`meetingModelId` for meetings.",
  },
  {
    term: "service",
    concept: "ai-service",
    means:
      "A company or daemon that runs text AI or transcription for you and that you may need a key for: Ollama, OpenAI, Anthropic, Gemini, DeepSeek, Deepgram, ElevenLabs, Groq, Cohere.",
  },
  {
    term: "speech model",
    concept: "speech-model",
    means: "The downloadable weights a speech engine runs.",
  },
  {
    term: "ai model",
    concept: "ai-model",
    means: "The model an AI service uses to write a summary or clean up a dictation.",
  },
  {
    term: "speaker separation model",
    concept: "diarization-model",
    means: "The embedding model that splits a transcript up by who was talking.",
  },
  {
    term: "on this mac",
    concept: "on-device",
    means:
      "Processing that happens on the user's own machine and sends nothing anywhere.",
  },
  {
    term: "command line and mcp access",
    concept: "automation-surface",
    means:
      "The `plainsong` command, its read-only MCP server, and `plainsong://` links. Gated by `automation.localToolsEnabled`.",
  },
  {
    term: "voice signature",
    concept: "voiceprint",
    means:
      "The numeric signature kept for a named speaker when `meetings.rememberVoices` is on. Never called a profile.",
  },
  {
    term: "binding",
    concept: "dictation-binding",
    means:
      "One row of `shortcuts.dictationBindings`: a trigger, an action and a hold/toggle behaviour.",
  },
];

/**
 * A phrase that used to be on screen, the word that replaced it, and why.
 *
 * `pattern` is matched case-insensitively against settings-surface source with
 * comments stripped, so a comment may still discuss the history (this file
 * does). Keep patterns narrow enough that they cannot fire on an unrelated
 * sentence -- a false positive here is a test nobody trusts.
 */
export interface RetiredTerm {
  pattern: RegExp;
  /** How to say it now. */
  useInstead: string;
  /** The collision it caused. */
  because: string;
}

export const RETIRED_SETTINGS_TERMS: readonly RetiredTerm[] = [
  {
    pattern: /\bcustom modes?\b/i,
    useInstead: "saved profile / saved profiles",
    because:
      '"Mode" also named the capture mode, the insertion mode and the platform-tuning mode. The Dictation view already called these profiles.',
  },
  {
    pattern: /\bdictation modes?\b/i,
    useInstead: "dictation profile",
    because: "Same collision, and the same feature under a second name.",
  },
  {
    pattern: /\bcloud providers?\b/i,
    useInstead: "cloud service",
    because:
      '"Provider" also named the speech engine and the cloud storage destination.',
  },
  {
    pattern: /\banalysis provider\b/i,
    useInstead: "AI service",
    because: "Internal vocabulary that reached the screen.",
  },
  {
    pattern: /\blocal tools\b/i,
    useInstead: "command line and MCP access",
    because:
      '"Local" already meant "on this Mac" for processing and "prefer local" for routing. This was its third meaning on one tab.',
  },
  {
    pattern: /\bmeeting quality policy\b/i,
    useInstead: "which meeting engine Plainsong offers first",
    because:
      'It set no quality and enforced no policy: it only reorders the meetings list. It also sat two tabs from the list it reorders.',
  },
  {
    pattern: /\bshared route\b/i,
    useInstead: "speech engine (dictation and meetings)",
    because: '"Route" is an internal word for an engine-and-model pair.',
  },
];

/**
 * Terms whose concepts collide, as `[term, concepts]`. Empty is the contract.
 * Exported so the test reports the offending word rather than a bare boolean.
 */
export function termsWithTwoConcepts(
  vocabulary: readonly VocabularyTerm[] = SETTINGS_VOCABULARY,
): Array<[string, string[]]> {
  const byTerm = new Map<string, Set<string>>();
  for (const entry of vocabulary) {
    const concepts = byTerm.get(entry.term) ?? new Set<string>();
    concepts.add(entry.concept);
    byTerm.set(entry.term, concepts);
  }
  return [...byTerm.entries()]
    .filter(([, concepts]) => concepts.size > 1)
    .map(([term, concepts]) => [term, [...concepts].sort()] as [string, string[]]);
}

/**
 * Concepts with two names, as `[concept, terms]`. Also empty by contract: two
 * words for one thing is how the app got here.
 */
export function conceptsWithTwoTerms(
  vocabulary: readonly VocabularyTerm[] = SETTINGS_VOCABULARY,
): Array<[string, string[]]> {
  const byConcept = new Map<string, Set<string>>();
  for (const entry of vocabulary) {
    const terms = byConcept.get(entry.concept) ?? new Set<string>();
    terms.add(entry.term);
    byConcept.set(entry.concept, terms);
  }
  return [...byConcept.entries()]
    .filter(([, terms]) => terms.size > 1)
    .map(([concept, terms]) => [concept, [...terms].sort()] as [string, string[]]);
}

/**
 * Source with `//` and block comments removed, so a retired phrase can be
 * discussed in a comment (explaining why it went) without failing the gate.
 *
 * JSX comments are `{/* ... *\/}`, which the block-comment rule already covers.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
