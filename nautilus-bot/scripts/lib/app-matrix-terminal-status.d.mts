export function evaluateAppMatrixTerminalStatus(artifact: {
  status?: unknown;
  pass?: unknown;
  verifyMode?: unknown;
  checksAllPassed?: unknown;
  rowClosure?: { closesMatrixRow?: unknown } | null;
} | null): string[];
