import { invoke } from "@/lib/electron";

export const CHATGPT_PLAN_PROVIDER = "chatgpt_plan";

export interface ChatGptAccount {
  clientId: string;
  email?: string;
  label: string;
  active: boolean;
  connected: boolean;
  planEnabled: boolean;
}

export interface ChatGptPlanModel {
  slug: string;
  displayName: string;
}

export interface ChatGptPlanStatus {
  loaded: boolean;
  modelsReady: boolean;
  accounts: ChatGptAccount[];
  models: ChatGptPlanModel[];
  modelError?: string;
  remoteRevocation?: "confirmed" | "unconfirmed" | "not_needed";
}

export const EMPTY_CHATGPT_PLAN_STATUS: ChatGptPlanStatus = {
  loaded: false,
  modelsReady: false,
  accounts: [],
  models: [],
};

function normalizeStatus(value: unknown): ChatGptPlanStatus {
  if (!value || typeof value !== "object") {
    return EMPTY_CHATGPT_PLAN_STATUS;
  }
  const candidate = value as Partial<ChatGptPlanStatus>;
  return {
    loaded: candidate.loaded === true,
    modelsReady: candidate.modelsReady === true,
    accounts: Array.isArray(candidate.accounts) ? candidate.accounts : [],
    models: Array.isArray(candidate.models) ? candidate.models : [],
    ...(typeof candidate.modelError === "string" ? { modelError: candidate.modelError } : {}),
    ...(candidate.remoteRevocation ? { remoteRevocation: candidate.remoteRevocation } : {}),
  };
}

async function callStatusCommand(
  command: string,
  args?: Record<string, unknown>,
): Promise<ChatGptPlanStatus> {
  return normalizeStatus(await invoke<unknown>(command, args));
}

export function getChatGptPlanStatus(): Promise<ChatGptPlanStatus> {
  return callStatusCommand("chatgpt_get_status");
}

export function refreshChatGptPlanAccounts(): Promise<ChatGptPlanStatus> {
  return callStatusCommand("chatgpt_refresh");
}

export function connectChatGptPlan(clientId?: string): Promise<ChatGptPlanStatus> {
  return callStatusCommand("chatgpt_connect", clientId ? { clientId } : {});
}

export function cancelChatGptPlanConnect(): Promise<ChatGptPlanStatus> {
  return callStatusCommand("chatgpt_cancel_connect");
}

export function selectChatGptPlanAccount(clientId: string): Promise<ChatGptPlanStatus> {
  return callStatusCommand("chatgpt_select_account", { clientId });
}

export function signOutChatGptPlan(clientId?: string): Promise<ChatGptPlanStatus> {
  return callStatusCommand("chatgpt_sign_out", clientId ? { clientId } : {});
}
