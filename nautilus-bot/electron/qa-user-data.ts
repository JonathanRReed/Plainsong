import { realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type QaUserDataOptions = {
  required?: boolean;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  tmpdir?: string;
  realpath?: (directory: string) => string;
  isDirectory?: (directory: string) => boolean;
};

export function resolveQaUserData({
  required = false,
  env = process.env,
  argv = process.argv,
  tmpdir = os.tmpdir(),
  realpath = realpathSync,
  isDirectory = (directory) => statSync(directory).isDirectory(),
}: QaUserDataOptions = {}): string | null {
  if (env.PLAINSONG_QA_MODE !== "1") {
    if (required) throw new Error("This local QA build requires its temporary-profile launcher.");
    return null;
  }

  let requested = env.PLAINSONG_QA_ELECTRON_PROFILE;
  if (requested === undefined) {
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument.startsWith("--user-data-dir=")) {
        requested = argument.slice("--user-data-dir=".length);
        break;
      }
      if (argument === "--user-data-dir") {
        requested = argv[index + 1];
        break;
      }
    }
  }
  if (!requested?.trim() || requested.startsWith("--")) {
    throw new Error("Packaged QA requires an existing temporary Electron profile.");
  }

  const directory = realpath(requested);
  const temporaryRoot = realpath(tmpdir);
  const relative = path.relative(temporaryRoot, directory);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !isDirectory(directory)
  ) {
    throw new Error("Packaged QA Electron profile must be a directory inside the temporary directory.");
  }
  return directory;
}
