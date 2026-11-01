import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_INDEX,
  SETTINGS_SECTIONS,
} from "@/components/settings/settings-sections";
import { resolveSettingsSection, type SettingsTabId } from "@/lib/navigation";

/**
 * Every "Settings > Section > Row" a reader is told to follow has to lead
 * somewhere. Error messages from the sidecar, hints in the renderer and the
 * user guides all name places in Settings; when Settings is reorganized those
 * sentences silently start pointing at tabs that no longer exist. This walks
 * the source and the user-facing docs and checks each path against the
 * sections and rows Settings actually has.
 */

const appRoot = path.resolve(__dirname, "..", "..");

const SCANNED = [
  "src",
  "electron",
  "rust-sidecar/src",
  "docs/beta",
  "docs/automation.md",
  "docs/cloud-sync-byoc.md",
];

function* walk(target: string): Generator<string> {
  const stat = statSync(target);
  if (stat.isFile()) {
    if (/\.(ts|tsx|rs|md)$/.test(target)) yield target;
    return;
  }
  for (const name of readdirSync(target)) {
    if (name === "node_modules" || name === "target") continue;
    yield* walk(path.join(target, name));
  }
}

/** HTML entities and the arrow spellings all mean the same separator. */
function normalize(text: string): string {
  return text
    .replace(/&gt;|&rarr;|→|›/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\\\n\s*/g, "") // Rust string continuation
    .replace(/\s*\n\s*(?:\/\/\s*|\*\s*)?/g, " "); // wrapped prose and comments
}

interface FoundPath {
  file: string;
  text: string;
}

function findSettingsPaths(): FoundPath[] {
  const found: FoundPath[] = [];
  for (const root of SCANNED) {
    for (const file of walk(path.join(appRoot, root))) {
      if (file.endsWith("settings-paths.test.ts")) continue;
      const text = normalize(readFileSync(file, "utf8"));
      const pattern = /(System )?Settings > ([^"'`<)\]\n]{1,120})/g;
      for (const match of text.matchAll(pattern)) {
        if (match[1]) continue; // macOS System Settings
        found.push({ file: path.relative(appRoot, file), text: match[2] });
      }
    }
  }
  return found;
}

const sectionLabels = SETTINGS_SECTIONS.map((section) => section.label);

/** Names a path may use after the section: a row's label or its group. */
function knownRowNames(sectionLabel: string): string[] {
  const section = SETTINGS_SECTIONS.find((entry) => entry.label === sectionLabel);
  return SETTINGS_INDEX.filter((entry) => entry.section === section?.id).map(
    (entry) => entry.label,
  );
}

describe("Settings paths named in messages and docs", () => {
  const paths = findSettingsPaths();

  it("finds the paths it is meant to police", () => {
    // A scanner that finds nothing proves nothing.
    expect(paths.length).toBeGreaterThan(30);
  });

  it("names only sections Settings has", () => {
    const wrong = paths
      .filter(({ text }) => !sectionLabels.some((label) => text.startsWith(label)))
      .map(({ file, text }) => `${file}: Settings > ${text.slice(0, 60)}`);
    expect(wrong).toEqual([]);
  });

  it("names only rows that exist in the section it names", () => {
    const wrong: string[] = [];
    for (const { file, text } of paths) {
      const section = sectionLabels.find((label) => text.startsWith(label));
      if (!section) continue;
      const rest = text.slice(section.length);
      if (!rest.startsWith(" > ")) continue; // a section on its own
      const row = rest.slice(3);
      const rows = knownRowNames(section);
      if (!rows.some((name) => row.toLowerCase().startsWith(name.toLowerCase()))) {
        wrong.push(`${file}: Settings > ${section} > ${row.slice(0, 50)}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("Settings deep links", () => {
  const sectionIds = SETTINGS_SECTIONS.map((section) => section.id);
  const rowIds = new Set(SETTINGS_INDEX.map((entry) => entry.id));

  it("lands every old section id on a section that exists", () => {
    for (const legacy of ["asr", "security", "storage", "updates"] as const) {
      expect(sectionIds).toContain(resolveSettingsSection(legacy as SettingsTabId));
    }
  });

  it("asks only for sections and rows that exist", () => {
    const wrong: string[] = [];
    for (const root of ["src", "electron"]) {
      for (const file of walk(path.join(appRoot, root))) {
        if (file.includes("__tests__")) continue;
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(
          /requestSettingsTab\(\s*"([a-z]+)"(?:\s*,\s*"([a-z-]+)")?/g,
        )) {
          const [, tab, focus] = match;
          const where = path.relative(appRoot, file);
          if (!sectionIds.includes(resolveSettingsSection(tab as SettingsTabId))) {
            wrong.push(`${where}: section "${tab}"`);
          }
          if (focus && !rowIds.has(focus)) {
            wrong.push(`${where}: row "${focus}"`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
