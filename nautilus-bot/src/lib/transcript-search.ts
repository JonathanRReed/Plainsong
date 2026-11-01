export interface TranscriptHighlightRange {
  start: number;
  end: number;
  matchIndex: number;
  isStart: boolean;
}

interface TranscriptSegment {
  id: string;
  text: string;
  startTime: number;
}

interface SourceSpan {
  segmentIndex: number;
  start: number;
  end: number;
}

interface SearchUnit {
  value: string;
  sources: SourceSpan[];
  whitespace: boolean;
}

const foldCase = (value: string) =>
  value.toLowerCase().normalize("NFD").replace(/\u03c2/g, "\u03c3");

const normalizeQuery = (query: string) => {
  let normalized = "";
  let inWhitespace = false;

  for (const character of query.trim()) {
    if (/\s/u.test(character)) {
      if (!inWhitespace) normalized += " ";
      inWhitespace = true;
      continue;
    }

    normalized += foldCase(character);
    inWhitespace = false;
  }

  return normalized;
};

const buildSearchUnits = (segments: readonly TranscriptSegment[]) => {
  const units: SearchUnit[] = [];

  const appendWhitespace = (source?: SourceSpan) => {
    const previous = units[units.length - 1];
    if (previous?.whitespace) {
      if (source) previous.sources.push(source);
      return;
    }

    units.push({ value: " ", sources: source ? [source] : [], whitespace: true });
  };

  segments.forEach((segment, segmentIndex) => {
    let offset = 0;
    for (const character of segment.text) {
      const end = offset + character.length;
      const source = { segmentIndex, start: offset, end };

      if (/\s/u.test(character)) {
        appendWhitespace(source);
      } else {
        const folded = foldCase(character);
        for (let index = 0; index < folded.length; index += 1) {
          units.push({ value: folded[index], sources: [source], whitespace: false });
        }
      }
      offset = end;
    }

    if (segmentIndex < segments.length - 1) appendWhitespace();
  });

  return units;
};

const mergeHitSources = (sources: readonly SourceSpan[]) => {
  const bySegment = new Map<number, SourceSpan[]>();

  for (const source of sources) {
    const ranges = bySegment.get(source.segmentIndex) ?? [];
    const previous = ranges[ranges.length - 1];
    if (previous && source.start <= previous.end) {
      previous.end = Math.max(previous.end, source.end);
    } else {
      ranges.push({ ...source });
    }
    bySegment.set(source.segmentIndex, ranges);
  }

  return bySegment;
};

const overlapsAcceptedRange = (
  ranges: ReadonlyMap<number, readonly SourceSpan[]>,
  acceptedEnds: ReadonlyMap<number, number>,
) => {
  for (const [segmentIndex, candidates] of ranges) {
    const acceptedEnd = acceptedEnds.get(segmentIndex);
    if (
      acceptedEnd !== undefined &&
      candidates.some((candidate) => candidate.start < acceptedEnd)
    ) {
      return true;
    }
  }
  return false;
};

export function findTranscriptMatches(
  segments: readonly TranscriptSegment[],
  query: string,
): {
  matches: { segmentId: string; startTime: number }[];
  rangesBySegment: Map<string, readonly TranscriptHighlightRange[]>;
} {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return { matches: [], rangesBySegment: new Map() };

  const units = buildSearchUnits(segments);
  const searchableText = units.map((unit) => unit.value).join("");
  const matches: { segmentId: string; startTime: number }[] = [];
  const rangesBySegment = new Map<string, TranscriptHighlightRange[]>();
  const acceptedEnds = new Map<number, number>();

  let searchFrom = 0;
  while (searchFrom <= searchableText.length - normalizedQuery.length) {
    const foundAt = searchableText.indexOf(normalizedQuery, searchFrom);
    if (foundAt < 0) break;
    searchFrom = foundAt + normalizedQuery.length;

    const hitSources = units
      .slice(foundAt, foundAt + normalizedQuery.length)
      .flatMap((unit) => unit.sources);
    const hitRanges = mergeHitSources(hitSources);
    if (hitRanges.size === 0 || overlapsAcceptedRange(hitRanges, acceptedEnds)) {
      continue;
    }

    const firstSource = hitSources[0];
    const firstSegment = segments[firstSource.segmentIndex];
    const matchIndex = matches.length;
    matches.push({ segmentId: firstSegment.id, startTime: firstSegment.startTime });

    let isFirstSlice = true;
    for (const [segmentIndex, sourceRanges] of hitRanges) {
      const segmentId = segments[segmentIndex].id;
      const highlights = rangesBySegment.get(segmentId) ?? [];

      for (const sourceRange of sourceRanges) {
        highlights.push({
          start: sourceRange.start,
          end: sourceRange.end,
          matchIndex,
          isStart: isFirstSlice,
        });
        isFirstSlice = false;
      }

      rangesBySegment.set(segmentId, highlights);
      const lastRange = sourceRanges[sourceRanges.length - 1];
      if (lastRange) acceptedEnds.set(segmentIndex, lastRange.end);
    }
  }

  for (const highlights of rangesBySegment.values()) {
    highlights.sort((left, right) => left.start - right.start);
  }

  return { matches, rangesBySegment };
}
