/**
 * Plainsong Plus, the optional paid hosted tier. NOT LAUNCHED.
 *
 * Only a sidecar built with the `plainsong-plus` Cargo feature reports
 * `available: true`; every shipped build reports false, and every Plus
 * surface in the renderer renders nothing on false. See
 * docs/plainsong-plus.md and infra/plus-worker.
 */
import { useEffect, useState } from "react";
import { invoke } from "@/lib/electron";

export interface PlusUsage {
  period: string;
  usage: { dictationSeconds?: number; meetingSeconds?: number; llmTokens?: number };
  caps: { dictationSeconds: number; meetingSeconds: number; llmTokens: number };
  remaining: { dictationSeconds: number; meetingSeconds: number; llmTokens: number };
}

export interface PlusStatus {
  available: boolean;
  signedIn: boolean;
  serviceUrl?: string;
  usage?: PlusUsage;
  error?: string;
}

export const PLUS_ANALYSIS_PROVIDER = "plainsong-plus";

/** The relay's two chat aliases, fast first (the dictation default). */
export const PLUS_CHAT_MODELS = ["plainsong-fast", "plainsong-quality"] as const;

const UNAVAILABLE: PlusStatus = { available: false, signedIn: false };

export async function getPlusStatus(): Promise<PlusStatus> {
  try {
    const status = await invoke<PlusStatus>("plus_get_status");
    return status && typeof status.available === "boolean" ? status : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

export async function activatePlus(licenseKey: string): Promise<PlusStatus> {
  return await invoke<PlusStatus>("plus_activate", { licenseKey });
}

export async function signOutPlus(): Promise<void> {
  await invoke("plus_sign_out");
}

/** Whether this build has Plus at all. Asked once per window. */
let availability: Promise<boolean> | null = null;

function plusAvailable(): Promise<boolean> {
  availability ??= getPlusStatus().then((status) => status.available);
  return availability;
}

export function usePlusAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    void plusAvailable().then((value) => {
      if (live) setAvailable(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return available;
}

/** "3.2 of 15 hours" style usage line, in whole or tenth hours. */
export function formatHours(seconds: number): string {
  const hours = seconds / 3600;
  return hours >= 10 || Number.isInteger(hours) ? `${Math.round(hours)}` : hours.toFixed(1);
}
