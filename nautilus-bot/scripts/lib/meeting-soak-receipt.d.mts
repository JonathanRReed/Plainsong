export function sanitizeMeetingSoakReceipt<T extends Record<string, unknown>>(
  artifact: T,
): T & {
  contentRedacted: true;
  transcriptEvidence: {
    characters: number;
    segmentCount: number;
    contentRedacted: true;
  };
};
