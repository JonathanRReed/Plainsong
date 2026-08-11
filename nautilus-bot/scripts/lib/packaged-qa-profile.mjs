import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function valueFor(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return null;
  return args[index + 1];
}

function pathsMatch(left, right) {
  return path.resolve(left) === path.resolve(right);
}

const ROOT_OWNED_MACOS_ALIASES = new Map([
  ["/tmp", "/private/tmp"],
  ["/var", "/private/var"],
  ["/etc", "/private/etc"],
]);

function isAllowedRootOwnedMacosAlias(componentPath, stat) {
  if (process.platform !== "darwin" || !stat.isSymbolicLink() || stat.uid !== 0) {
    return false;
  }
  const expectedTarget = ROOT_OWNED_MACOS_ALIASES.get(componentPath);
  return Boolean(
    expectedTarget && fs.realpathSync.native(componentPath) === expectedTarget,
  );
}

function assertNoSymlinkedDestinationComponents(destination) {
  const resolved = path.resolve(destination);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const components = resolved
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);

  for (const component of components) {
    current = path.join(current, component);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() && !isAllowedRootOwnedMacosAlias(current, stat)) {
      throw new Error(
        `Refusing to use a symlinked packaged QA profile destination: ${current}`,
      );
    }
  }
}

function expectedMacosDestinationPath(destination) {
  const resolved = path.resolve(destination);
  if (process.platform !== "darwin") return resolved;
  for (const [alias, target] of ROOT_OWNED_MACOS_ALIASES) {
    if (resolved === alias || resolved.startsWith(`${alias}${path.sep}`)) {
      return `${target}${resolved.slice(alias.length)}`;
    }
  }
  return resolved;
}

function verifyDestinationResolvedWithoutLinks(destination) {
  assertNoSymlinkedDestinationComponents(destination);
  if (fs.realpathSync.native(destination) !== expectedMacosDestinationPath(destination)) {
    throw new Error(
      `Refusing to use a symlinked packaged QA profile destination: ${destination}`,
    );
  }
}

function cloneTree(source, destination) {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Refusing to clone a symlinked packaged QA fixture: ${source}`);
  }
  if (sourceStat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: sourceStat.mode });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      cloneTree(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Unsupported packaged QA fixture entry: ${source}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  copyPackagedQaFixtureFile(source, destination);
}

export function copyPackagedQaFixtureFile(
  source,
  destination,
  copyFileSync = fs.copyFileSync,
) {
  try {
    copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
  } catch (error) {
    if (!["ENOTSUP", "EOPNOTSUPP", "EXDEV", "EINVAL", "ENOSYS"].includes(error?.code)) {
      throw error;
    }
    copyFileSync(source, destination);
  }
}

function cloneDatabaseSchema(sourceDb, destinationDb) {
  if (!fs.existsSync(sourceDb) || fs.existsSync(destinationDb)) return;

  // `.schema` includes SQLite-owned AUTOINCREMENT and FTS shadow tables. The
  // virtual-table declaration recreates its own shadow tables, so replaying the
  // raw output is both invalid and needlessly coupled to private user data.
  const schemaQuery = `
    SELECT sql || ';'
    FROM sqlite_schema
    WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
      AND name NOT IN (
        SELECT name FROM pragma_table_list WHERE type = 'shadow'
      )
    ORDER BY CASE type
      WHEN 'table' THEN 0
      WHEN 'index' THEN 1
      WHEN 'view' THEN 2
      WHEN 'trigger' THEN 3
      ELSE 4
    END, rowid;
  `;
  const schema = spawnSync("sqlite3", [sourceDb, schemaQuery], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (schema.status !== 0) {
    throw new Error(
      `Unable to read the packaged QA database schema: ${(schema.stderr ?? "").trim()}`,
    );
  }

  fs.mkdirSync(path.dirname(destinationDb), { recursive: true });
  const create = spawnSync("sqlite3", [destinationDb], {
    input: schema.stdout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (create.status !== 0) {
    fs.rmSync(destinationDb, { force: true });
    throw new Error(
      `Unable to create the packaged QA database schema: ${(create.stderr ?? "").trim()}`,
    );
  }
}

/**
 * Resolve a disposable profile for a packaged QA launcher.
 *
 * Defaults never point at the operator's live Application Support directory.
 * An explicit --profile-root or paired PLAINSONG_CONFIG_DIR / DATA_DIR is
 * caller-owned, but the live roots are still rejected. Missing fixture inputs
 * are populated read-only from the live profile: settings and model files are
 * APFS clones, while SQLite receives schema only and no user rows.
 */
export function createPackagedQaProfile({
  args = process.argv.slice(2),
  prefix = "plainsong-packaged-qa-",
  sourceProfileDir = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Plainsong",
  ),
  registerCleanup = true,
} = {}) {
  const requestedProfileRoot = valueFor(args, "--profile-root");
  const explicitConfigRoot = process.env.PLAINSONG_CONFIG_DIR?.trim() || null;
  const explicitDataRoot = process.env.PLAINSONG_DATA_DIR?.trim() || null;
  if (!requestedProfileRoot && Boolean(explicitConfigRoot) !== Boolean(explicitDataRoot)) {
    throw new Error(
      "Packaged QA isolation requires both PLAINSONG_CONFIG_DIR and PLAINSONG_DATA_DIR.",
    );
  }

  let profileRoot;
  let configRoot;
  let dataRoot;
  let ownsProfileRoot = false;

  if (requestedProfileRoot) {
    profileRoot = path.resolve(requestedProfileRoot);
    configRoot = path.join(profileRoot, "config");
    dataRoot = path.join(profileRoot, "data");
  } else if (explicitConfigRoot && explicitDataRoot) {
    configRoot = path.resolve(explicitConfigRoot);
    dataRoot = path.resolve(explicitDataRoot);
    profileRoot = path.dirname(configRoot) === path.dirname(dataRoot)
      ? path.dirname(configRoot)
      : null;
  } else {
    profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    configRoot = path.join(profileRoot, "config");
    dataRoot = path.join(profileRoot, "data");
    ownsProfileRoot = true;
  }

  const liveApplicationSupportRoot = path.join(
    os.homedir(),
    "Library",
    "Application Support",
  );
  if (
    (profileRoot && pathsMatch(profileRoot, liveApplicationSupportRoot)) ||
    pathsMatch(configRoot, liveApplicationSupportRoot) ||
    pathsMatch(dataRoot, liveApplicationSupportRoot)
  ) {
    if (ownsProfileRoot && profileRoot) {
      fs.rmSync(profileRoot, { recursive: true, force: true });
    }
    throw new Error(
      "Refusing to run packaged QA against the live Plainsong Application Support profile.",
    );
  }

  const configDir = path.join(configRoot, "Plainsong");
  const dataDir = path.join(dataRoot, "Plainsong");
  const electronUserDataDir = path.join(
    profileRoot ?? dataRoot,
    "electron-user-data",
  );
  try {
    if (!ownsProfileRoot) {
      for (const destination of [configDir, dataDir, electronUserDataDir]) {
        assertNoSymlinkedDestinationComponents(destination);
      }
    }

    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(electronUserDataDir, { recursive: true });

    if (!ownsProfileRoot) {
      for (const destination of [configDir, dataDir, electronUserDataDir]) {
        verifyDestinationResolvedWithoutLinks(destination);
      }
    }

    const sourceSettings = path.join(sourceProfileDir, "settings.json");
    const destinationSettings = path.join(configDir, "settings.json");
    if (fs.existsSync(sourceSettings) && !fs.existsSync(destinationSettings)) {
      cloneTree(sourceSettings, destinationSettings);
    }

    const sourceModels = path.join(sourceProfileDir, "models");
    const destinationModels = path.join(dataDir, "models");
    if (fs.existsSync(sourceModels) && !fs.existsSync(destinationModels)) {
      cloneTree(sourceModels, destinationModels);
    }

    cloneDatabaseSchema(
      path.join(sourceProfileDir, "plainsong.db"),
      path.join(dataDir, "plainsong.db"),
    );
  } catch (error) {
    if (ownsProfileRoot && profileRoot) {
      fs.rmSync(profileRoot, { recursive: true, force: true });
    }
    throw error;
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (ownsProfileRoot && profileRoot) {
      fs.rmSync(profileRoot, { recursive: true, force: true });
    }
  };
  if (registerCleanup) process.once("exit", cleanup);

  return {
    profileRoot,
    configRoot,
    dataRoot,
    configDir,
    dataDir,
    electronUserDataDir,
    appArgs: [`--user-data-dir=${electronUserDataDir}`],
    ownsProfileRoot,
    isolated: true,
    env: {
      PLAINSONG_QA_MODE: "1",
      PLAINSONG_CONFIG_DIR: configRoot,
      PLAINSONG_DATA_DIR: dataRoot,
    },
    cleanup,
  };
}
