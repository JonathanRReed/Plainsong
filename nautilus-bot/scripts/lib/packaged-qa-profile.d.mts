export interface PackagedQaProfile {
  profileRoot: string | null;
  configRoot: string;
  dataRoot: string;
  configDir: string;
  dataDir: string;
  electronUserDataDir: string;
  appArgs: [string];
  ownsProfileRoot: boolean;
  isolated: true;
  env: {
    PLAINSONG_QA_MODE: "1";
    PLAINSONG_CONFIG_DIR: string;
    PLAINSONG_DATA_DIR: string;
  };
  cleanup(): void;
}

export function copyPackagedQaFixtureFile(
  source: string,
  destination: string,
  copyFileSync?: (source: string, destination: string, mode?: number) => void,
): void;

export function createPackagedQaProfile(options?: {
  args?: string[];
  prefix?: string;
  sourceProfileDir?: string;
  registerCleanup?: boolean;
}): PackagedQaProfile;
