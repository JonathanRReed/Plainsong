import spokenEditExamples from "@/lib/dictation-spoken-edit-examples.json";

export const DICTATION_SPOKEN_EDIT_COMMAND_EXAMPLES = spokenEditExamples.map(
  (example) => example.phrase,
);

export function normalizeDictationCommandPrefix(prefix: string): string {
  return prefix.trim() || "command";
}

function formatDictationSpokenCommandExample(
  prefix: string,
  phrase: string,
): string {
  return `${normalizeDictationCommandPrefix(prefix)} ${phrase}`;
}

export function getDictationSpokenEditCommandExamples(prefix: string): string[] {
  return DICTATION_SPOKEN_EDIT_COMMAND_EXAMPLES.map((phrase) =>
    formatDictationSpokenCommandExample(prefix, phrase),
  );
}
