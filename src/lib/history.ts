"use client";

/**
 * Client-side processing history, persisted in IndexedDB.
 *
 * Every completed translation is recorded here so the user can revisit past
 * jobs and re-download both the uploaded source and the translated output —
 * including the large layout-preserving PDFs — without re-running the
 * translation. Storing in the browser keeps the feature self-contained: it
 * needs no extra Azure infrastructure, survives reloads, and matches the app's
 * single-user model. The newest {@link MAX_ENTRIES} jobs are kept; older ones
 * are pruned automatically.
 */

import type { EvaluationReport } from "./evaluation";

export interface HistoryEntry {
  id: string;
  /** ISO timestamp when the translation completed. */
  createdAt: string;
  mode: "text" | "layout";
  fileName: string;
  targetLanguage: string;
  detectedLanguage?: string;
  // --- Text view payload ---
  originalText?: string;
  translatedText?: string;
  // --- Layout payload ---
  isImage?: boolean;
  ext?: string;
  translatedName?: string;
  // --- Stored files for re-download ---
  originalBlob?: Blob;
  translatedBlob?: Blob;
  // --- Optional evaluation (present only when the toggle was on) ---
  evaluation?: EvaluationReport;
}

const DB_NAME = "doc-translator";
const DB_VERSION = 1;
const STORE = "history";
const MAX_ENTRIES = 50;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("Could not open the history database."));
  });
}

function getAll(db: IDBDatabase): Promise<HistoryEntry[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as HistoryEntry[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

const byNewestFirst = (a: HistoryEntry, b: HistoryEntry) =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;

/** Records a completed translation. Drops the oldest entries past the cap. */
export async function addHistoryEntry(entry: HistoryEntry): Promise<void> {
  if (!hasIndexedDb()) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const req = db
        .transaction(STORE, "readwrite")
        .objectStore(STORE)
        .put(entry);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    await pruneOld(db);
  } finally {
    db.close();
  }
}

/** Returns all history entries, newest first. */
export async function getAllHistory(): Promise<HistoryEntry[]> {
  if (!hasIndexedDb()) return [];
  const db = await openDb();
  try {
    const all = await getAll(db);
    return all.sort(byNewestFirst);
  } finally {
    db.close();
  }
}

/** Deletes a single history entry by id. */
export async function deleteHistoryEntry(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const req = db
        .transaction(STORE, "readwrite")
        .objectStore(STORE)
        .delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Clears the entire history. */
export async function clearHistory(): Promise<void> {
  if (!hasIndexedDb()) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE, "readwrite").objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function pruneOld(db: IDBDatabase): Promise<void> {
  const all = (await getAll(db)).sort(byNewestFirst);
  if (all.length <= MAX_ENTRIES) return;
  const stale = all.slice(MAX_ENTRIES);
  await new Promise<void>((resolve, reject) => {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    let remaining = stale.length;
    stale.forEach((entry) => {
      const req = store.delete(entry.id);
      req.onsuccess = () => {
        if (--remaining === 0) resolve();
      };
      req.onerror = () => reject(req.error);
    });
  });
}
