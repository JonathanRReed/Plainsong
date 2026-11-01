import { describe, expect, it, vi } from "vitest";
import { createChatGPTPlanController } from "../../electron/chatgpt-plan-controller";
import { ChatGPTPlanError } from "../../electron/chatgpt-plan-api";
import type { createChatGPTPlanSession, ChatGPTAccountSummary } from "../../electron/chatgpt-plan-session";
const account: ChatGPTAccountSummary = {clientId:"oaiapp_test",label:"ChatGPT account 1",active:true,connected:true,planEnabled:true};
function fixture() {
 const session={listAccounts:vi.fn(async()=>[account]),listModels:vi.fn(async()=>[{slug:"account-model",displayName:"Account model"}]),connect:vi.fn(async()=>account),selectAccount:vi.fn(async()=>account),signOut:vi.fn(async()=>({remoteRevocation:"confirmed" as const})),notifyCloudPermissionChanged:vi.fn()};
 let enabled=true;const changed=vi.fn();const controller=createChatGPTPlanController(session as unknown as ReturnType<typeof createChatGPTPlanSession>,()=>enabled,changed);
 return {session,controller,changed,setCloud(value:boolean){enabled=value;controller.privacyChanged();}};
}
describe("main-process ChatGPT account controller",()=>{
 it("reads no protected data to show initial cached status",()=>{const f=fixture();expect(f.controller.cachedStatus()).toEqual({loaded:false,accounts:[],models:[],modelsReady:false});expect(f.session.listAccounts).not.toHaveBeenCalled();});
 it("keeps identity sign-in separate from plan permission and model discovery",async()=>{const f=fixture();f.session.listAccounts.mockResolvedValue([{...account,planEnabled:false}]);const status=await f.controller.refresh();expect(status.accounts[0].connected).toBe(true);expect(status.modelsReady).toBe(false);expect(f.session.listModels).not.toHaveBeenCalled();});
 it("does not let a late catalogue response overwrite a privacy change",async()=>{const f=fixture();let finish!:()=>void;f.session.listModels.mockImplementation(()=>new Promise(resolve=>{finish=()=>resolve([{slug:"stale",displayName:"Stale"}]);}));const refresh=f.controller.refresh();await new Promise(resolve=>setTimeout(resolve,0));f.setCloud(false);finish();await refresh;expect(f.controller.cachedStatus().models).toEqual([]);expect(f.controller.cachedStatus().modelsReady).toBe(false);});
 it("reflects terminal grant clearance without opening another OS storage operation",async()=>{const f=fixture();await f.controller.refresh();const reads=f.session.listAccounts.mock.calls.length;f.controller.accountsChanged([{...account,active:false,connected:false,planEnabled:false}]);expect(f.controller.relayStatus().connected).toBe(false);expect(f.controller.cachedStatus().models).toEqual([]);expect(f.session.listAccounts).toHaveBeenCalledTimes(reads);});
 it("does not treat a failed catalogue query as an empty fresh model list",async()=>{const f=fixture();f.session.listModels.mockRejectedValue(new Error("private-provider-content"));const status=await f.controller.refresh();expect(status.modelsReady).toBe(false);expect(status.modelError).not.toContain("private-provider-content");});
 it("can reflect explicit local sign-out when cloud is disabled",async()=>{const f=fixture();await f.controller.refresh();f.setCloud(false);const status=await f.controller.signOut();expect(status.accounts[0].connected).toBe(false);expect(status.remoteRevocation).toBe("confirmed");});
 it("keeps eligibility recovery visible without reconnecting or retrying",async()=>{const f=fixture();const error=new ChatGPTPlanError("not_eligible");f.session.listModels.mockRejectedValue(error);const status=await f.controller.refresh();expect(status.modelError).toBe(error.message);expect(status.modelsReady).toBe(false);expect(status.accounts[0].connected).toBe(true);expect(f.session.listModels).toHaveBeenCalledOnce();expect(f.session.connect).not.toHaveBeenCalled();});
});
