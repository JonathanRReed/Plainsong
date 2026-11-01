// Use paths reported by this Cargo invocation, including cached artifacts.
// Cargo resolves target directories, configured triples, and platform suffixes.
interface CargoMessage {
  reason?: string;
  manifest_path?: string;
  target?: { kind?: string[]; name: string };
  executable?: unknown;
  message?: { rendered?: string };
}

export function recordCargoExecutable(
  line: string,
  outputs: Map<string, string>,
  manifestPath: string,
): string | undefined {
  const message = JSON.parse(line) as CargoMessage;
  if (
    message.reason === "compiler-artifact" &&
    message.manifest_path === manifestPath &&
    message.target?.kind?.includes("bin") &&
    typeof message.executable === "string" &&
    message.executable.length > 0
  ) {
    outputs.set(message.target!.name, message.executable);
  }
  return message.message?.rendered;
}

export function requireCargoExecutables(
  outputs: ReadonlyMap<string, string>,
  names: readonly string[],
): Map<string, string> {
  return new Map(names.map((name) => {
    const executable = outputs.get(name);
    if (!executable) {
      throw new Error(`Cargo did not report an executable for ${name}`);
    }
    return [name, executable] as const;
  }));
}
