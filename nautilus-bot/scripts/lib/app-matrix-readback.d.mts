export const VERIFY_MODES: readonly string[];

export function isBrowserApp(appName: unknown): boolean;
export function makeNonce(): string;
export function normalizeReadBackValue(value: unknown): string;

export interface FrontmostApplicationResult {
  ok: boolean;
  name: string | null;
  bundleId: string | null;
  error: string | null;
}

export function readFrontmostApplication(): FrontmostApplicationResult;

export interface AppMatrixReadBackSession {
  prepare(): Promise<Record<string, unknown>>;
  readBack(): Promise<Record<string, unknown>>;
  cleanup(): Promise<Record<string, unknown>>;
}

export function createReadBackSession(
  mode: string,
  options?: Record<string, unknown>,
): Promise<AppMatrixReadBackSession>;
