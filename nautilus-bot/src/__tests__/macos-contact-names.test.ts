import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTACT_NAMES_REFRESH_MS,
  createContactNamesSync,
  parseContactsHelperOutput,
  type ContactsHelperExec,
} from "../../electron/macos-contact-names";

function helper(responses: Record<string, unknown>) {
  const calls: string[][] = [];
  const exec: ContactsHelperExec = async (_path, args) => {
    calls.push(args);
    return { stdout: `${JSON.stringify(responses[args[0]] ?? {})}\n` };
  };
  return { calls, exec };
}

const NAMES = {
  protocolVersion: 1,
  type: "contact_names",
  authorization: "authorized",
  names: ["Siobhan", "Nguyen", " ", "x".repeat(65)],
};

function setup(options: { enabled: boolean; responses?: Record<string, unknown> }) {
  let enabled = options.enabled;
  let clock = 0;
  const sent: string[][] = [];
  const { calls, exec } = helper(
    options.responses ?? {
      "--contact-names": NAMES,
      "--contacts-probe": { type: "contacts_probe", authorization: "authorized" },
      "--contacts-request-access": { type: "contacts_probe", authorization: "authorized" },
    },
  );
  const sync = createContactNamesSync({
    platform: "darwin",
    helperPath: "/helper",
    helperExists: () => true,
    isEnabled: () => enabled,
    sendNames: async (names) => {
      sent.push(names);
    },
    exec,
    now: () => clock,
  });
  return {
    sync,
    sent,
    calls,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("parseContactsHelperOutput", () => {
  it("keeps only usable names, and only from a granted names payload", () => {
    expect(parseContactsHelperOutput(JSON.stringify(NAMES)).names).toEqual(["Siobhan", "Nguyen"]);
    expect(
      parseContactsHelperOutput(JSON.stringify({ ...NAMES, authorization: "denied" })),
    ).toEqual({ authorization: "denied", names: [] });
    expect(
      parseContactsHelperOutput(JSON.stringify({ ...NAMES, type: "contacts_probe" })).names,
    ).toEqual([]);
  });

  it("reads anything unexpected as unknown", () => {
    expect(parseContactsHelperOutput("")).toEqual({ authorization: "unknown", names: [] });
    expect(parseContactsHelperOutput("not json")).toEqual({ authorization: "unknown", names: [] });
    expect(parseContactsHelperOutput('{"authorization":"maybe"}').authorization).toBe("unknown");
  });
});

describe("createContactNamesSync", () => {
  it("never runs the helper while the switch is off", async () => {
    const harness = setup({ enabled: false });
    await harness.sync.sync();
    expect(harness.calls).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it("sends the names once on, and clears them once off", async () => {
    const harness = setup({ enabled: true });
    await harness.sync.sync({ force: true });
    expect(harness.calls).toEqual([["--contact-names"]]);
    expect(harness.sent).toEqual([["Siobhan", "Nguyen"]]);

    harness.setEnabled(false);
    await harness.sync.sync({ force: true });
    expect(harness.sent.at(-1)).toEqual([]);
    expect(harness.calls).toHaveLength(1);
  });

  it("refreshes at most once per interval unless forced", async () => {
    const harness = setup({ enabled: true });
    await harness.sync.sync({ force: true });
    await harness.sync.sync();
    expect(harness.calls).toHaveLength(1);
    harness.advance(CONTACT_NAMES_REFRESH_MS);
    await harness.sync.sync();
    expect(harness.calls).toHaveLength(2);
  });

  it("reads status without prompting, and prompts only on request", async () => {
    const harness = setup({ enabled: false });
    expect((await harness.sync.status()).authorization).toBe("authorized");
    expect(harness.calls).toEqual([["--contacts-probe"]]);
    await harness.sync.requestAccess();
    expect(harness.calls.map((args) => args[0])).toContain("--contacts-request-access");
  });

  it("answers unavailable off macOS without running anything", async () => {
    const { calls, exec } = helper({});
    const sync = createContactNamesSync({
      platform: "linux",
      helperPath: "/helper",
      isEnabled: () => true,
      sendNames: async () => undefined,
      exec,
    });
    expect((await sync.status()).authorization).toBe("unsupported_platform");
    await sync.sync({ force: true });
    expect(calls).toEqual([]);
  });
});

describe("Contacts access is never requested without a user gesture", () => {
  const repoRoot = process.cwd();
  const read = (file: string) => readFileSync(path.join(repoRoot, file), "utf8");

  it("gates the prompting command in the main process", () => {
    const main = read("electron/main.ts");
    const start = main.indexOf('case "request_contacts_access"');
    expect(start).toBeGreaterThan(-1);
    const body = main.slice(start, main.indexOf("case ", start + 10));
    expect(body).toContain('requireMainWindowGesture("Using names from Contacts")');
    expect(body.indexOf("requireMainWindowGesture(")).toBeLessThan(body.indexOf("requestAccess()"));
  });

  it("is called from the switch's change handler only", () => {
    const setting = read("src/components/settings/contact-names-setting.tsx");
    const effect = setting.slice(setting.indexOf("useEffect("), setting.indexOf("}, []);"));
    expect(effect).not.toContain("requestContactsAccess");
    expect(setting).toContain("await requestContactsAccess()");
    expect(read("src/components/views/settings-view-simple.tsx")).not.toContain(
      "requestContactsAccess",
    );
  });

  it("keeps the names away from the renderer", () => {
    expect(read("electron/ipc-bridge.ts")).not.toContain('"set_dictation_contact_names"');
    expect(read("src/lib/backend/contacts.ts")).not.toContain("names:");
  });
});

describe("Contacts permission revocation", () => {
  it("clears held hints when the stored permission becomes denied", async () => {
    let authorization = "authorized";
    const sent: string[][] = [];
    const sync = createContactNamesSync({
      platform: "darwin", helperPath: "/fake", helperExists: () => true, isEnabled: () => true,
      exec: async (_path, args) => ({ stdout: JSON.stringify({ type: args[0] === "--contact-names" ? "contact_names" : "contacts_probe", authorization, names: ["Siobhan"] }) }),
      sendNames: async (names) => { sent.push(names); },
    });
    await sync.sync({ force: true });
    authorization = "denied";
    expect(await sync.status()).toEqual({ authorization: "denied", nameCount: 0 });
    expect(sent).toEqual([["Siobhan"], []]);
  });
});

it("a late denied status probe cannot clear a newer authorized refresh", async () => {
  let finishProbe!: (output: { stdout: string }) => void;
  const sent: string[][] = [];
  const sync = createContactNamesSync({
    platform: "darwin", helperPath: "/fake", helperExists: () => true, isEnabled: () => true,
    exec: async (_path, args) => args[0] === "--contacts-probe"
      ? new Promise((resolve) => { finishProbe = resolve; })
      : { stdout: JSON.stringify({ type: "contact_names", authorization: "authorized", names: ["Siobhan"] }) },
    sendNames: async (names) => { sent.push(names); },
  });
  await sync.sync({ force: true });
  const status = sync.status(); await Promise.resolve();
  const refresh = sync.sync({ force: true });
  finishProbe({ stdout: JSON.stringify({ type: "contacts_probe", authorization: "denied" }) });
  await status; await refresh;
  expect(sent).toEqual([["Siobhan"], [], ["Siobhan"]]);
});
