const settingsPatchBrand: unique symbol = Symbol("SettingsPatch");

type Operation =
  | { readonly op: "set"; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: "remove"; readonly path: readonly string[] };

export type SettingsPatch = {
  readonly operations: readonly Operation[];
  readonly [settingsPatchBrand]: true;
};

function patch(operations: readonly Operation[]): SettingsPatch {
  return { operations, [settingsPatchBrand]: true };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonSnapshot(value: object): Record<string, unknown> {
  const snapshot: unknown = JSON.parse(JSON.stringify(value));
  if (!isObject(snapshot)) throw new Error("Settings must be an object.");
  return snapshot;
}

export function diffSettings(before: object, after: object): SettingsPatch {
  const operations: Operation[] = [];
  function visit(left: Record<string, unknown>, right: Record<string, unknown>, path: string[]) {
    for (const key of Object.keys(left)) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) {
        operations.push({ op: "remove", path: [...path, key] });
      }
    }
    for (const key of Object.keys(right)) {
      const nextPath = [...path, key];
      const previous = Object.prototype.hasOwnProperty.call(left, key) ? left[key] : undefined;
      const next = right[key];
      if (isObject(previous) && isObject(next)) {
        visit(previous, next, nextPath);
      } else if (JSON.stringify(previous) !== JSON.stringify(next)) {
        operations.push({ op: "set", path: nextPath, value: next });
      }
    }
  }
  visit(jsonSnapshot(before), jsonSnapshot(after), []);
  return patch(operations);
}

export function editSettings<T extends object>(before: T, mutate: (draft: T) => void): SettingsPatch {
  const draft = structuredClone(before);
  const touched: string[][] = [];
  function track<U extends object>(target: U, path: string[]): U {
    return new Proxy(target, {
      get(object, key, receiver) {
        const value: unknown = Reflect.get(object, key, receiver);
        return typeof key === "string" && Object.prototype.hasOwnProperty.call(object, key) && isObject(value)
          ? track(value, [...path, key]) : value;
      },
      set(object, key, value: unknown) {
        if (typeof key !== "string") throw new Error("Settings keys must be strings.");
        Object.defineProperty(object, key, {
          value, enumerable: true, configurable: true, writable: true,
        });
        touched.push([...path, key]);
        return true;
      },
      deleteProperty(object, key) {
        if (typeof key !== "string") throw new Error("Settings keys must be strings.");
        touched.push([...path, key]);
        return Reflect.deleteProperty(object, key);
      },
    });
  }
  mutate(track(draft, []));
  const final = jsonSnapshot(draft);
  const explicit: Operation[] = [];
  const roots = touched.filter((path) => !touched.some((ancestor) =>
    ancestor.length < path.length && ancestor.every((part, index) => path[index] === part),
  ));
  for (const path of roots) {
    let value: unknown = final;
    let absent = false;
    for (const part of path) {
      if (!isObject(value) || !Object.prototype.hasOwnProperty.call(value, part)) {
        absent = true;
        break;
      }
      value = value[part];
    }
    explicit.push(absent ? { op: "remove", path } : { op: "set", path, value });
  }
  return mergeSettingsPatches(diffSettings(before, final), patch(explicit));
}

export function mergeSettingsPatches(...patches: SettingsPatch[]): SettingsPatch {
  let operations: Operation[] = [];
  for (const next of patches.flatMap((entry) => entry.operations)) {
    operations = operations.filter((previous) =>
      !next.path.every((part, index) => previous.path[index] === part),
    );
    operations.push(structuredClone(next));
  }
  return patch(operations);
}

export function applySettingsPatch<T extends object>(snapshot: T, changes: SettingsPatch): T {
  const result = structuredClone(snapshot);
  for (const operation of changes.operations) {
    let parent: unknown = result;
    let absent = false;
    for (const part of operation.path.slice(0, -1)) {
      if (!isObject(parent)) throw new Error("Settings patch parent must be an object.");
      if (!Object.prototype.hasOwnProperty.call(parent, part)) {
        if (operation.op === "remove") {
          absent = true;
          break;
        }
        throw new Error("Settings patch parent does not exist.");
      }
      parent = parent[part];
    }
    if (absent) continue;
    const key = operation.path[operation.path.length - 1];
    if (key === undefined) throw new Error("Invalid settings patch path.");
    if (!isObject(parent)) throw new Error("Settings patch parent must be an object.");
    if (operation.op === "remove") {
      delete parent[key];
    } else {
      Object.defineProperty(parent, key, {
        value: structuredClone(operation.value), enumerable: true, configurable: true, writable: true,
      });
    }
  }
  return result;
}
