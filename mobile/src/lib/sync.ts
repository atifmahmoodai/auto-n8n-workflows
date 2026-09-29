import { AuthError } from "./auth";
import { getReceipt, listUnsyncedIds, setSyncStatus } from "./db";
import { HttpError } from "./http";
import { appendReceiptToSheet } from "./sheets";

const inFlight = new Map<string, Promise<boolean>>();

function describe(error: unknown): string {
  if (error instanceof AuthError) return error.message;
  if (error instanceof HttpError) {
    if (error.status === 0) return error.message;
    if (error.status === 403) return "Google Sheets access was denied. Sign out and sign in again to grant access.";
    if (error.status === 429) return "Google Sheets is rate limiting requests. We'll retry shortly.";
    return `Google Sheets error (${error.status}): ${error.message}`;
  }
  return "Couldn't sync this receipt. We'll try again later.";
}

/** Syncs one receipt to Google Sheets. Never throws; returns true on success. */
export function syncReceipt(id: string): Promise<boolean> {
  const existing = inFlight.get(id);
  if (existing) return existing;
  const task = (async () => {
    try {
      const receipt = await getReceipt(id);
      if (!receipt) return false;
      if (receipt.syncStatus === "synced") return true;
      await appendReceiptToSheet(receipt);
      await setSyncStatus(id, "synced");
      return true;
    } catch (error) {
      console.warn(`Sync failed for ${id}`, error);
      await setSyncStatus(id, "failed", describe(error)).catch(() => {});
      return false;
    } finally {
      inFlight.delete(id);
    }
  })();
  inFlight.set(id, task);
  return task;
}

let syncAllTask: Promise<{ synced: number; failed: number }> | null = null;

/** Syncs every pending/failed receipt, one at a time (keeps Sheets row order stable). */
export function syncAllPending(): Promise<{ synced: number; failed: number }> {
  if (syncAllTask) return syncAllTask;
  syncAllTask = (async () => {
    let synced = 0;
    let failed = 0;
    try {
      for (const id of await listUnsyncedIds()) {
        if (await syncReceipt(id)) synced++;
        else failed++;
      }
    } finally {
      syncAllTask = null;
    }
    return { synced, failed };
  })();
  return syncAllTask;
}
