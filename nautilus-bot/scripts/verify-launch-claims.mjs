#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath =
  outIndex >= 0 && args[outIndex + 1]
    ? path.resolve(repoRoot, args[outIndex + 1])
    : path.resolve(repoRoot, "artifacts/launch-claim-check.json");

const scanRoots = [
  "README.md",
  "src",
  "docs/launch-claim-scope.md",
  "docs/launch-readiness-dashboard.md",
  "docs/launch-completion-audit.md",
  "docs/final-ship-checklist.md",
];

const ignoredPathPatterns = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)dist-electron\//,
  /(^|\/)release\//,
  /(^|\/)artifacts\//,
  /(^|\/)docs\/plans\//,
  /(^|\/)docs\/superpowers\//,
  /(^|\/)docs\/evals\//,
  /(^|\/)src\/__tests__\//,
];

const allowList = [
  {
    file: "docs/launch-claim-scope.md",
    pattern: /Do not claim that Nautilus works in every app\./,
  },
  {
    file: "docs/launch-claim-scope.md",
    pattern: /Do not claim that Nautilus is launch-certified for any app until packaged evidence exists\./,
  },
  {
    file: "docs/launch-claim-scope.md",
    pattern: /Do not claim that cloud-backed workflows are fully local\./,
  },
  {
    file: "docs/launch-claim-scope.md",
    pattern: /Do not claim hosted Nautilus cloud storage\./,
  },
  {
    file: "docs/launch-claim-scope.md",
    pattern: /Prefer `local-first` over `fully local`\./,
  },
  {
    file: "README.md",
    pattern: /cloud providers are optional bring-your-own-key integrations, not fully local workflows/,
  },
  {
    file: "README.md",
    pattern: /Do not describe cloud-backed workflows as fully local\./,
  },
  {
    file: "docs/final-ship-checklist.md",
    pattern: /Any app that does not pass the launch bar is removed from launch claims\./,
  },
  {
    file: "docs/final-ship-checklist.md",
    pattern: /Remove any language suggesting .works everywhere. unless the packaged app matrix actually proves it\./,
  },
  {
    file: "docs/final-ship-checklist.md",
    pattern: /Remove any language suggesting .fully local. for workflows that still depend on cloud providers\./,
  },
];

const disallowed = [
  {
    id: "works-everywhere",
    pattern: /\bworks everywhere\b/i,
    message: "Avoid claiming broad app coverage before the app matrix passes.",
  },
  {
    id: "every-app",
    pattern: /\bevery app\b/i,
    message: "Avoid claiming every-app support before the app matrix passes.",
  },
  {
    id: "any-app",
    pattern: /\bany app\b/i,
    message: "Avoid claiming any-app support before the app matrix passes.",
  },
  {
    id: "launch-certified-app",
    pattern: /\blaunch-certified for any app\b/i,
    message: "No app is launch-certified until packaged app evidence exists.",
  },
  {
    id: "fully-local-cloud",
    pattern: /\bfully local\b/i,
    message: "Use local-first unless the specific workflow has no cloud dependency.",
  },
  {
    id: "hosted-cloud-storage",
    pattern: /\bhosted Nautilus cloud storage\b/i,
    message: "Use bring-your-own-cloud sync, not hosted cloud storage.",
  },
];

function shouldIgnore(relativePath) {
  return ignoredPathPatterns.some((pattern) => pattern.test(relativePath));
}

function isAllowed(relativePath, line) {
  return allowList.some(
    (entry) => entry.file === relativePath && entry.pattern.test(line)
  );
}

function listFiles(entry) {
  const fullPath = path.join(repoRoot, entry);
  if (!fs.existsSync(fullPath)) {
    return [];
  }
  const stat = fs.statSync(fullPath);
  if (stat.isFile()) {
    return [fullPath];
  }

  const files = [];
  for (const child of fs.readdirSync(fullPath)) {
    const childPath = path.join(fullPath, child);
    const relativePath = path.relative(repoRoot, childPath);
    if (shouldIgnore(relativePath)) {
      continue;
    }
    const childStat = fs.statSync(childPath);
    if (childStat.isDirectory()) {
      files.push(...listFiles(relativePath));
    } else if (/\.(md|mdx|ts|tsx|js|jsx|json)$/.test(childPath)) {
      files.push(childPath);
    }
  }
  return files;
}

const findings = [];
for (const root of scanRoots) {
  for (const filePath of listFiles(root)) {
    const relativePath = path.relative(repoRoot, filePath);
    if (shouldIgnore(relativePath)) {
      continue;
    }
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (isAllowed(relativePath, line)) {
        return;
      }
      for (const rule of disallowed) {
        if (rule.pattern.test(line)) {
          findings.push({
            rule: rule.id,
            file: relativePath,
            line: index + 1,
            message: rule.message,
            text: line.trim(),
          });
        }
      }
    });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  pass: findings.length === 0,
  scanRoots,
  findingCount: findings.length,
  findings,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
