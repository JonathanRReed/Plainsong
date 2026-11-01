import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
const appRoot = process.env.B24_APP_ROOT;
if (!appRoot) throw new Error("B24_APP_ROOT is required");
const { createPackagedQaProfile } = await import(path.join(appRoot, "scripts/lib/packaged-qa-profile.ts"));

const packagedApp = process.env.B24_APP;
const binaryPath = packagedApp ? path.join(packagedApp, "Contents/MacOS/Plainsong")
  : path.join(appRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const work = path.resolve(process.argv[2] ?? ".");

fs.mkdirSync(path.join(work, "cmd"), { recursive: true });

const emptySource = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-fresh-empty-source-"));
const profileRoot = process.env.B24_PROFILE;
if (!profileRoot) throw new Error("B24_PROFILE is required");
const profile = createPackagedQaProfile({
  args: ["--profile-root", profileRoot],
  sourceProfileDir: emptySource,
  registerCleanup: false,
});
const settingsPath = path.join(profile.configDir, "settings.json");
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
settings.ui = { ...settings.ui, dictationSounds: false };
fs.writeFileSync(settingsPath, JSON.stringify(settings));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const logPath = path.join(work, "app-output.log");
const logStream = fs.createWriteStream(logPath);
const events: Array<{ at: string; step: string; value: unknown }> = [];
const record = (step: string, value: unknown) => {
  events.push({ at: new Date().toISOString(), step, value });
  fs.writeFileSync(path.join(work, "events.json"), JSON.stringify({ profileRoot, emptySource, events }, null, 2));
  console.log(`[${step}]`, JSON.stringify(value).slice(0, 2000));
};

class Cdp {
  nextId = 1;
  pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  sessionId: string | null = null;
  constructor(private input: Writable, output: Readable) {
    let buffered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      buffered += chunk;
      const frames = buffered.split("\0");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        if (!frame) continue;
        const message = JSON.parse(frame);
        if (message.method === "Page.javascriptDialogOpening") {
          fs.appendFileSync(path.join(work,"dialogs.jsonl"),JSON.stringify({at:new Date().toISOString(),...message.params})+"\n");
          const priorSession = this.sessionId;
          this.sessionId = message.sessionId ?? this.sessionId;
          void this.send("Page.handleJavaScriptDialog",{accept:fs.existsSync(path.join(work,"accept-dialogs"))}).catch(error=>fs.appendFileSync(path.join(work,"dialog-errors.jsonl"),JSON.stringify({at:new Date().toISOString(),error:String(error)})+"\n"));
          this.sessionId = priorSession;
        }
        const entry = this.pending.get(message.id);
        if (!entry) continue;
        this.pending.delete(message.id);
        message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
      }
    });
  }
  send(method: string, params: Record<string, unknown> = {}, browser = false): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 180_000);
      this.pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
      const message: Record<string, unknown> = { id, method, params };
      if (this.sessionId && !browser) message.sessionId = this.sessionId;
      this.input.write(`${JSON.stringify(message)}\0`);
    });
  }
  async evaluate(expression: string): Promise<unknown> {
    const result = (await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
      exceptionDetails?: { text: string; exception?: { description?: string } };
      result: { value?: unknown };
    };
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
}

function listTree(dir: string): Array<{ path: string; bytes: number }> {
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ path: string; bytes: number }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTree(full));
    else out.push({ path: path.relative(profile.profileRoot ?? profile.dataRoot, full), bytes: fs.lstatSync(full).size });
  }
  return out;
}

const child = spawn(binaryPath, [...(packagedApp ? [] : [appRoot]), ...profile.appArgs, "--remote-debugging-pipe"], {
  detached: true,
  stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  env: { ...process.env, ...profile.env, ELECTRON_ENABLE_LOGGING: "1", PLAINSONG_RENDERER_MODE: "file", PLAINSONG_QA_EPHEMERAL_SECRETS: "1" },
});
child.stdout!.on("data", (c: Buffer) => logStream.write(c));
child.stderr!.on("data", (c: Buffer) => logStream.write(c));
let exited = false;
setTimeout(()=>{record("driver-deadline",{minutes:30});try{process.kill(-child.pid!,"SIGTERM");}catch{};process.exit(2);},30*60_000).unref();
child.on("exit", (code, signal) => { exited = true; record("app-exit", { code, signal }); });

async function main() {
  record("profile", { profileRoot, configDir: profile.configDir, dataDir: profile.dataDir, launchedAt: new Date().toISOString(), pid: child.pid });
  record("models-before-launch", listTree(path.join(profile.dataDir, "models")));
  const cdp = new Cdp(child.stdio[3] as Writable, child.stdio[4] as Readable);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && !cdp.sessionId) {
    const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: Array<{ targetId: string; type: string; url?: string }> };
    const page = targetInfos.find((t) => t.type === "page" && typeof t.url === "string" && !t.url.includes("overlay") && !t.url.startsWith("devtools://"));
    if (page) cdp.sessionId = ((await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true })) as { sessionId: string }).sessionId;
    else await delay(250);
  }
  if (!cdp.sessionId) throw new Error("no renderer target");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  const bodyDeadline=Date.now()+90_000;
  let bodyReady=false;
  while(Date.now()<bodyDeadline && !bodyReady) {
    try {bodyReady=await cdp.evaluate("Boolean(document.body && window.electronAPI?.invoke)") as boolean;} catch {}
    if(!bodyReady)await delay(100);
  }
  if(!bodyReady)throw Error("Owned renderer body and API did not become ready");
  record("interactive-ready",{body:true,api:true});

  // Interactive phase.
  let n = 1;

  while (!exited) {
    const quit = path.join(work, "cmd", "quit");
    if (fs.existsSync(quit)) { await Promise.race([cdp.send("Browser.close").catch(()=>undefined),delay(3000)]); break; }
    const file = path.join(work, "cmd", `${n}.js`);
    if (fs.existsSync(file)) {
      let value: unknown;
      const mainSession: string | null = cdp.sessionId;
      let overlaySession: string | null = null;
      let commandSession: string | null = null;
      const script=fs.readFileSync(file,"utf8");
      try {
        if (!script.startsWith("// browser-cdp-command") && !script.startsWith("// recording-overlay") && !script.startsWith("// dictation-overlay")) {
          const {targetInfos}=await cdp.send("Target.getTargets",{},true) as {targetInfos:Array<{targetId:string;type:string;url:string}>};
          const page=targetInfos.find(t=>t.type==="page"&&!t.url.includes("overlay")&&!t.url.startsWith("devtools:"));
          if (!page) throw Error("Owned main target is absent");
          commandSession=((await cdp.send("Target.attachToTarget",{targetId:page.targetId,flatten:true},true)) as {sessionId:string}).sessionId;
          cdp.sessionId=commandSession;
          await cdp.send("Page.enable");
        }
        if(script.startsWith("// recording-overlay") || script.startsWith("// dictation-overlay")) {
          const targets=await cdp.send("Target.getTargets",{},true) as {targetInfos:Array<{targetId:string;type:string;url?:string}>};
          const target=targets.targetInfos.find(t=>t.type==="page"&&t.url?.includes(script.startsWith("// dictation-overlay")?"overlay=dictation":"overlay=recording"));
          if(!target)throw Error("owned recording overlay absent");
          overlaySession=((await cdp.send("Target.attachToTarget",{targetId:target.targetId,flatten:true},true)) as {sessionId:string}).sessionId;
          cdp.sessionId=overlaySession;
          await cdp.send("Page.enable");
        }
        if(script.includes("// gesture")) {
          await cdp.send("Page.bringToFront");
          const pt=await cdp.evaluate(`(()=>{const r=document.querySelector("main#main-content").getBoundingClientRect();return{x:r.left+8,y:r.top+8}})()`) as {x:number;y:number};
          await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",...pt,button:"left",buttons:1,clickCount:1});
          await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",...pt,button:"left",buttons:0,clickCount:1});
        }
        if(script.startsWith("// browser-cdp-command")) {
          const command=JSON.parse(script.substring(script.indexOf("\n")+1));
          value=await cdp.send(command.method,command.params||{},true);
        } else if(script.startsWith("// cdp-command")) {
          const command=JSON.parse(script.substring(script.indexOf("\n")+1));
          value=await cdp.send(command.method,command.params||{});
        } else value=await cdp.evaluate(script);
      } catch(error) {value={error:String(error)};}
      const output = path.join(work, "cmd", `${n}.out.json`);
      fs.writeFileSync(`${output}.tmp`, JSON.stringify(value ?? null, null, 2));
      fs.renameSync(`${output}.tmp`, output);
      cdp.sessionId=mainSession;
      if(commandSession) await cdp.send("Target.detachFromTarget",{sessionId:commandSession},true).catch(()=>undefined);
      if(overlaySession) await cdp.send("Target.detachFromTarget",{sessionId:overlaySession},true).catch(()=>undefined);
      n += 1;
    }
    await delay(100);
  }
  const finalLog = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
  record("final", {
    huggingfaceLines: finalLog.filter((l) => /huggingface\.co/i.test(l)),
    downloadLines: finalLog.filter((l) => /download/i.test(l)),
    models: listTree(path.join(profile.dataDir, "models")),
  });
}

main()
  .catch((error) => record("error", String(error?.stack ?? error)))
  .finally(async () => {
    if (!exited) { try { process.kill(-child.pid!, "SIGTERM"); } catch {} }
    await delay(3000);
    if (!exited) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
    logStream.end();
    fs.rmSync(emptySource, { recursive: true, force: true });
    process.exit(0);
  });
