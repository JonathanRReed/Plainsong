type StringRegistryGroup = {
  label: string;
  values: readonly string[];
};

export function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

export function capitalizeString(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function formatStringList(values: readonly string[]): string {
  if (values.length === 0) {
    return "";
  }
  if (values.length === 1) {
    return values[0];
  }
  if (values.length === 2) {
    return `${values[0]} or ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1]}`;
}

export function assertUniqueStrings(
  scope: string,
  values: readonly string[],
): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
      continue;
    }
    seen.add(value);
  }

  if (duplicates.size > 0) {
    throw new Error(
      `Duplicate ${scope}: ${Array.from(duplicates).sort().join(", ")}`,
    );
  }
}

function normalizeRegistryString(value: string): string {
  // Pinned to "en-US" on purpose, and NOT left to the ambient locale. These
  // strings are identity keys for built-in registries, so the same input has to
  // normalize the same way on every Mac — under a Turkish locale a bare
  // toLocaleLowerCase() maps "I" to "\u0131" and two entries that collide
  // everywhere else stop colliding here. Also see src/lib/format-locale.ts:
  // text the USER reads follows the user's locale; keys never do.
  return value.trim().toLocaleLowerCase("en-US");
}

export function assertUniqueNormalizedStrings(
  scope: string,
  values: readonly string[],
): void {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];

  for (const value of values) {
    const normalizedValue = normalizeRegistryString(value);
    const existingValue = seen.get(normalizedValue);
    if (existingValue) {
      duplicates.push(`${value} (${existingValue})`);
      continue;
    }
    seen.set(normalizedValue, value);
  }

  if (duplicates.length > 0) {
    throw new Error(`Duplicate ${scope}: ${duplicates.join(", ")}`);
  }
}

export function combineNormalizedUniqueStringGroups(
  scope: string,
  groups: readonly StringRegistryGroup[],
): string[] {
  const values: string[] = [];
  const owners = new Map<string, string>();
  const duplicates: string[] = [];

  for (const group of groups) {
    for (const value of group.values) {
      const normalizedValue = normalizeRegistryString(value);
      const existingOwner = owners.get(normalizedValue);
      if (existingOwner) {
        duplicates.push(`${value} (${existingOwner}, ${group.label})`);
        continue;
      }
      owners.set(normalizedValue, group.label);
      values.push(value);
    }
  }

  if (duplicates.length > 0) {
    throw new Error(`Duplicate ${scope}: ${duplicates.join(", ")}`);
  }

  return values;
}
