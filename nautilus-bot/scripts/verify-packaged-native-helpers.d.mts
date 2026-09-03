export function hasDeliberateSignature(probe: {
  status: number;
  output: string;
}): boolean;

export default function verifyPackagedNativeHelpers(context: {
  electronPlatformName: string;
  appOutDir: string;
  packager: { appInfo: { productFilename: string } };
}): void;
