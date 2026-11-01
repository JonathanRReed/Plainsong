import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const names = ["plainsong-sidecar", "plainsong-cli"];

export function sidecarBuildReceiptPath(repoRoot) {
  return path.join(repoRoot, "dist-native", "sidecar-build-receipt.json");
}

function hashBinary(filePath, label) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error(`${label} must have an absolute binary path`);
  }
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0) throw new Error("not a non-empty regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let length;
    while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, length));
    }
    return hash.digest("hex");
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${filePath}: ${error.message}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function writeSidecarBuildReceipt(repoRoot, binaries, { profile = "unspecified" } = {}) {
  const receipt = {
    version: 1,
    createdAt: new Date().toISOString(),
    profile,
    binaries: Object.fromEntries(names.map((name) => {
      const binaryPath = binaries.get(name);
      return [name, { path: binaryPath, sha256: hashBinary(binaryPath, name) }];
    })),
  };
  const receiptPath = sidecarBuildReceiptPath(repoRoot);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.renameSync(temporaryPath, receiptPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return receipt;
}

export function verifySidecarBuildReceipt(repoRoot, packagedBinaries) {
  const receiptPath = sidecarBuildReceiptPath(repoRoot);
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read sidecar build receipt at ${receiptPath}: ${error.message}. Build the sidecar before packaging.`);
  }
  if (receipt?.version !== 1) throw new Error("Unsupported sidecar build receipt version");
  for (const name of names) {
    const binary = receipt.binaries?.[name];
    if (!binary || !/^[a-f0-9]{64}$/.test(binary.sha256 ?? "")) {
      throw new Error(`Sidecar build receipt is missing a valid SHA256 for ${name}`);
    }
    if (hashBinary(binary.path, `${name} build output`) !== binary.sha256) {
      throw new Error(`${name} build output changed since the sidecar build receipt was written`);
    }
    const packagedPath = packagedBinaries.get(name);
    if (hashBinary(packagedPath, `${name} packaged output`) !== binary.sha256) {
      throw new Error(`${name} packaged output at ${packagedPath} does not match the build receipt for ${binary.path}. Check the packaging source paths.`);
    }
  }
  return receipt;
}
