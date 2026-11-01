export function hasDeliberateSignature(probe: {
  status: number;
  output: string;
}): boolean;

export function verifySpeechHelperContract(appPath: string): void;

export function checkSpeechHelperContract(
  appPath: string,
  options?: {
    staticOnly?: boolean;
    verifier?: (appPath: string) => void;
  },
): boolean;

export function verifyAppBundle(
  appPath: string,
  expectedArchitecture: string,
  options?: {
    allowUnsigned?: boolean;
    staticOnly?: boolean;
    speechContractVerifier?: (appPath: string) => void;
  },
): {
  pass: true;
  appPath: string;
  expectedArchitecture: string;
  allowUnsigned: boolean;
  staticOnly: boolean;
  speechContractChecked: boolean;
  unsignedSkips: string[];
  paths: Record<string, string>;
  architectures: Record<string, string[]>;
};

export default function verifyPackagedNativeHelpers(context: {
  electronPlatformName: string;
  appOutDir: string;
  packager: { appInfo: { productFilename: string } };
}, options?: { staticOnly?: boolean }): void;
