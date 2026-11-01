import type { createChatGPTPlanSession, ChatGPTAccountSummary } from "./chatgpt-plan-session";
import { ChatGPTPlanError, type ChatGPTPlanModel } from "./chatgpt-plan-api";
import type { ChatGPTPlanRelayStatus } from "./chatgpt-plan-relay";

export interface ChatGPTPlanStatus {
  loaded: boolean;
  accounts: ChatGPTAccountSummary[];
  models: ChatGPTPlanModel[];
  modelsReady: boolean;
  modelError?: string;
  remoteRevocation?: "confirmed" | "unconfirmed" | "not_needed";
}
export function createChatGPTPlanController(session: ReturnType<typeof createChatGPTPlanSession>, remoteProcessingEnabled: () => boolean, changed: (status: ChatGPTPlanStatus) => void) {
  let status: ChatGPTPlanStatus = { loaded: false, accounts: [], models: [], modelsReady: false };
  const publish = (next: ChatGPTPlanStatus) => { status = next;changed(structuredClone(status));return structuredClone(status); };
  let revision = 0;
  async function refresh(remoteRevocation?: ChatGPTPlanStatus["remoteRevocation"], expectedRevision = ++revision) {
    let accounts = await session.listAccounts();
    let models: ChatGPTPlanModel[] = [];let modelError: string | undefined;let modelsReady = false;
    if (accounts.some(account => account.active && account.connected && account.planEnabled)) {
      try { models = await session.listModels();modelsReady = true; }
      catch (error) { modelError = error instanceof ChatGPTPlanError ? error.message : "ChatGPT models could not be loaded. Refresh before choosing a model."; }
    }
    if (expectedRevision !== revision) return structuredClone(status);
    // Refresh may have changed the grant or cleared an unusable token set.
    accounts = await session.listAccounts();
    if (expectedRevision !== revision) return structuredClone(status);
    return publish({ loaded: true, accounts, models, modelsReady, ...(modelError ? { modelError } : {}), ...(remoteRevocation ? { remoteRevocation } : {}) });
  }
  return {
    accountsChanged(accounts: ChatGPTAccountSummary[]) {
      const current = accounts.find(account => account.active);
      const previous = status.accounts.find(account => account.active);
      const keepModels = current?.clientId === previous?.clientId && current?.planEnabled === true;
      publish({ ...status, loaded: true, accounts, models: keepModels ? status.models : [], modelsReady: keepModels && status.modelsReady });
    },
    cachedStatus() { return structuredClone(status); },
    relayStatus(): ChatGPTPlanRelayStatus {
      const active = status.accounts.find(account => account.active);
      return { cloudEnabled: remoteProcessingEnabled(), loaded: status.loaded, connected: active?.connected === true, planEnabled: active?.planEnabled === true };
    },
    relayModels() { return status.models; },
    refresh,
    async connect(clientId?: string) { const current = ++revision;publish({ ...status, models: [], modelsReady: false });await session.connect(clientId);return refresh(undefined, current); },
    async select(clientId: string) { const current = ++revision;publish({ ...status, models: [], modelsReady: false });await session.selectAccount(clientId);return refresh(undefined, current); },
    async signOut(clientId?: string) {
      const current = ++revision;
      const result = await session.signOut(clientId);
      if (current !== revision) return structuredClone(status);
      // Local sign-out must still be reflected while cloud processing is off.
      if (!remoteProcessingEnabled()) {
        const target = clientId ?? status.accounts.find(account => account.active)?.clientId;
        return publish({ ...status, models: [], modelsReady: false, accounts: status.accounts.map(account => account.clientId === target ? { ...account, active: false, connected: false, planEnabled: false } : account), remoteRevocation: result.remoteRevocation });
      }
      return refresh(result.remoteRevocation, current);
    },
    cancelConnect() { revision += 1;session.notifyCloudPermissionChanged();return publish({ ...status, models: [], modelsReady: false }); },
    privacyChanged() { revision += 1;session.notifyCloudPermissionChanged();publish({ ...status, models: [], modelsReady: false }); },
  };
}
