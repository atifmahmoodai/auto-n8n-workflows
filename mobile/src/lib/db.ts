import * as SQLite from "expo-sqlite";
import { emitReceiptsChanged } from "./events";
import type { Category, Receipt, ReceiptItem, ReceiptSummary, SyncStatus } from "./types";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync("tally.db").then(async (db) => {
      await migrate(db);
      return db;
    });
    dbPromise.catch(() => {
      dbPromise = null; // allow a retry on next call
    });
  }
  return dbPromise;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE receipts (
    id TEXT PRIMARY KEY NOT NULL,
    merchant TEXT NOT NULL,
    purchase_date TEXT NOT NULL,
    currency TEXT NOT NULL,
    subtotal REAL,
    tax REAL,
    total REAL NOT NULL,
    payment_method TEXT,
    notes TEXT,
    image_uri TEXT,
    created_at TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    sync_error TEXT
  );
  CREATE INDEX receipts_purchase_date ON receipts (purchase_date DESC, created_at DESC);
  CREATE INDEX receipts_sync_status ON receipts (sync_status);
  CREATE TABLE receipt_items (
    id TEXT PRIMARY KEY NOT NULL,
    receipt_id TEXT NOT NULL REFERENCES receipts (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit_price REAL,
    total_price REAL NOT NULL,
    category TEXT NOT NULL
  );
  CREATE INDEX receipt_items_receipt ON receipt_items (receipt_id, position);
  CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
  `,
];

async function migrate(db: SQLite.SQLiteDatabase) {
  // journal_mode cannot be changed inside a transaction, so set pragmas first.
  await db.execAsync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const row = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  const current = row?.user_version ?? 0;
  for (let version = current; version < MIGRATIONS.length; version++) {
    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.execAsync(MIGRATIONS[version]!);
      await txn.execAsync(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

type ReceiptRow = {
  id: string;
  merchant: string;
  purchase_date: string;
  currency: string;
  subtotal: number | null;
  tax: number | null;
  total: number;
  payment_method: string | null;
  notes: string | null;
  image_uri: string | null;
  created_at: string;
  sync_status: SyncStatus;
  sync_error: string | null;
};

type ItemRow = {
  id: string;
  name: string;
  quantity: number;
  unit_price: number | null;
  total_price: number;
  category: string;
};

function toReceipt(row: ReceiptRow): Omit<Receipt, "items"> {
  return {
    id: row.id,
    merchant: row.merchant,
    purchaseDate: row.purchase_date,
    currency: row.currency,
    subtotal: row.subtotal,
    tax: row.tax,
    total: row.total,
    paymentMethod: row.payment_method,
    notes: row.notes,
    imageUri: row.image_uri,
    createdAt: row.created_at,
    syncStatus: row.sync_status,
    syncError: row.sync_error,
  };
}

function toItem(row: ItemRow): ReceiptItem {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    totalPrice: row.total_price,
    category: row.category as Category,
  };
}

export async function listReceipts(): Promise<ReceiptSummary[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<ReceiptRow & { item_count: number }>(
    `SELECT r.*, (SELECT COUNT(*) FROM receipt_items i WHERE i.receipt_id = r.id) AS item_count
     FROM receipts r ORDER BY r.purchase_date DESC, r.created_at DESC`,
  );
  return rows.map((row) => ({ ...toReceipt(row), itemCount: row.item_count }));
}

export async function getReceipt(id: string): Promise<Receipt | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<ReceiptRow>("SELECT * FROM receipts WHERE id = ?", id);
  if (!row) return null;
  const items = await db.getAllAsync<ItemRow>(
    "SELECT * FROM receipt_items WHERE receipt_id = ? ORDER BY position",
    id,
  );
  return { ...toReceipt(row), items: items.map(toItem) };
}

export async function insertReceipt(receipt: Receipt): Promise<void> {
  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      `INSERT INTO receipts (id, merchant, purchase_date, currency, subtotal, tax, total, payment_method,
         notes, image_uri, created_at, sync_status, sync_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      receipt.id,
      receipt.merchant,
      receipt.purchaseDate,
      receipt.currency,
      receipt.subtotal,
      receipt.tax,
      receipt.total,
      receipt.paymentMethod,
      receipt.notes,
      receipt.imageUri,
      receipt.createdAt,
      receipt.syncStatus,
      receipt.syncError,
    );
    for (const [position, item] of receipt.items.entries()) {
      await txn.runAsync(
        `INSERT INTO receipt_items (id, receipt_id, position, name, quantity, unit_price, total_price, category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        item.id,
        receipt.id,
        position,
        item.name,
        item.quantity,
        item.unitPrice,
        item.totalPrice,
        item.category,
      );
    }
  });
  emitReceiptsChanged();
}

export async function deleteReceipt(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM receipts WHERE id = ?", id);
  emitReceiptsChanged();
}

export async function setSyncStatus(id: string, status: SyncStatus, error: string | null = null): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE receipts SET sync_status = ?, sync_error = ? WHERE id = ?", status, error, id);
  emitReceiptsChanged();
}

export async function listUnsyncedIds(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>(
    "SELECT id FROM receipts WHERE sync_status != 'synced' ORDER BY created_at",
  );
  return rows.map((r) => r.id);
}

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string | null): Promise<void> {
  const db = await getDb();
  if (value === null) {
    await db.runAsync("DELETE FROM settings WHERE key = ?", key);
  } else {
    await db.runAsync(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }
}

/** Wipes local data, e.g. when a different Google account signs in. */
export async function clearAllData(): Promise<void> {
  const db = await getDb();
  await db.execAsync("DELETE FROM receipt_items; DELETE FROM receipts; DELETE FROM settings;");
  emitReceiptsChanged();
}
