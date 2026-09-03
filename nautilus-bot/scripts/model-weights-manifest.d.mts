export interface ModelWeightsEntry {
  /** Display name, as the app names it. */
  name: string;
  /** What the app does with it. */
  usedFor: string;
  /** Upstream repository page. */
  repository: string;
  /**
   * Immutable revision the download pins, or the branch plus a note when the
   * pin is a per-file SHA-256 instead.
   */
  revision: string;
  /** Upstream's declared license, or a sentence saying none is declared. */
  license: string;
  /** The artifacts fetched at that revision. */
  files: readonly string[];
  /** Source file holding the pin, so a reader can check the claim. */
  pinnedIn: string;
  /** An extra term or caveat that travels with the artifact. */
  note?: string;
  /** Upstream declares nothing and a human has not yet resolved it. */
  pendingLicenseReview?: boolean;
}

export const MODEL_WEIGHTS: readonly ModelWeightsEntry[];

export function renderModelWeightsSection(): string;
