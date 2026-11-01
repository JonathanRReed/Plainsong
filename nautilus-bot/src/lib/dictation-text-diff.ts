export type DictationTextDiffPart = {
  type: "equal" | "removed" | "added";
  text: string;
};

const MAX_LCS_CELLS = 250_000;

function appendPart(
  parts: DictationTextDiffPart[],
  type: DictationTextDiffPart["type"],
  text: string,
) {
  if (!text) return;

  const previous = parts[parts.length - 1];
  if (previous?.type === type) {
    previous.text += text;
    return;
  }
  parts.push({ type, text });
}

function tokenize(text: string) {
  return text.match(/\s+|[^\s]+/gu) ?? [];
}

function coarseDiff(originalTokens: string[], currentTokens: string[]) {
  let prefixLength = 0;
  const shorterLength = Math.min(originalTokens.length, currentTokens.length);
  while (
    prefixLength < shorterLength
    && originalTokens[prefixLength] === currentTokens[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < shorterLength - prefixLength
    && originalTokens[originalTokens.length - 1 - suffixLength]
      === currentTokens[currentTokens.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const parts: DictationTextDiffPart[] = [];
  appendPart(parts, "equal", originalTokens.slice(0, prefixLength).join(""));
  appendPart(
    parts,
    "removed",
    originalTokens.slice(prefixLength, originalTokens.length - suffixLength).join(""),
  );
  appendPart(
    parts,
    "added",
    currentTokens.slice(prefixLength, currentTokens.length - suffixLength).join(""),
  );
  if (suffixLength > 0) {
    appendPart(
      parts,
      "equal",
      originalTokens.slice(originalTokens.length - suffixLength).join(""),
    );
  }
  return parts;
}

/**
 * Produces a whitespace-preserving token diff. Large comparisons fall back to
 * a bounded prefix/suffix comparison instead of allocating an unbounded LCS
 * table.
 */
export function diffDictationText(
  original: string,
  current: string,
): DictationTextDiffPart[] {
  if (original === current) {
    return original ? [{ type: "equal", text: original }] : [];
  }

  const originalTokens = tokenize(original);
  const currentTokens = tokenize(current);
  const rows = originalTokens.length + 1;
  const columns = currentTokens.length + 1;

  if (rows * columns > MAX_LCS_CELLS) {
    return coarseDiff(originalTokens, currentTokens);
  }

  const table = new Uint32Array(rows * columns);
  const cell = (row: number, column: number) => row * columns + column;

  for (let row = originalTokens.length - 1; row >= 0; row -= 1) {
    for (let column = currentTokens.length - 1; column >= 0; column -= 1) {
      table[cell(row, column)] = originalTokens[row] === currentTokens[column]
        ? table[cell(row + 1, column + 1)] + 1
        : Math.max(
          table[cell(row + 1, column)],
          table[cell(row, column + 1)],
        );
    }
  }

  const parts: DictationTextDiffPart[] = [];
  let row = 0;
  let column = 0;
  while (row < originalTokens.length && column < currentTokens.length) {
    if (originalTokens[row] === currentTokens[column]) {
      appendPart(parts, "equal", originalTokens[row]);
      row += 1;
      column += 1;
    } else if (
      table[cell(row + 1, column)] >= table[cell(row, column + 1)]
    ) {
      appendPart(parts, "removed", originalTokens[row]);
      row += 1;
    } else {
      appendPart(parts, "added", currentTokens[column]);
      column += 1;
    }
  }

  while (row < originalTokens.length) {
    appendPart(parts, "removed", originalTokens[row]);
    row += 1;
  }
  while (column < currentTokens.length) {
    appendPart(parts, "added", currentTokens[column]);
    column += 1;
  }

  return parts;
}
