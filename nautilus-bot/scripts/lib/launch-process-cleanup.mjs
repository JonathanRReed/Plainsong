import { spawnSync } from "node:child_process";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findProfileProcessGroups(electronProfile) {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) return [];
  const marker = `--user-data-dir=${electronProfile}`;
  const markerPattern = new RegExp(
    `(?:^|\\s)${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`,
  );
  const groups = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (match?.[3] && markerPattern.test(match[3]))
      groups.add(Number(match[2]));
  }
  return [...groups].filter(
    (group) => Number.isSafeInteger(group) && group > 1,
  );
}

export async function terminateProfileProcesses(electronProfile) {
  let groups = findProfileProcessGroups(electronProfile);
  for (const group of groups) {
    try {
      process.kill(-group, "SIGTERM");
    } catch {}
  }
  for (let attempt = 0; attempt < 20 && groups.length > 0; attempt += 1) {
    await delay(25);
    groups = findProfileProcessGroups(electronProfile);
  }
  for (const group of groups) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {}
  }
  if (groups.length > 0) await delay(25);
  return findProfileProcessGroups(electronProfile);
}
