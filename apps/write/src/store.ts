/**
 * Local durable document store (WRITE-PERSIST-002).
 * Fallback chain: IndexedDB → localStorage → in-memory (ADR-0001 migration
 * step toward the §13.2 SQLite/local-blob topology). The store reports its
 * durability class so the UI can tell the user when persistence is degraded,
 * instead of silently losing work (§1.2.5).
 */

export interface StoredDocMeta {
  id: string;
  title: string;
  updatedAt: string;
}

export interface StoredDoc extends StoredDocMeta {
  doc: unknown; // engine DocModel as plain JSON
}

export type Durability = "durable" | "session" | "memory-only";

export interface DocumentStore {
  kind: string;
  durability: Durability;
  list(): Promise<StoredDocMeta[]>;
  load(id: string): Promise<StoredDoc | null>;
  save(doc: StoredDoc): Promise<void>;
  remove(id: string): Promise<void>;
}

// ---------- IndexedDB ----------
const IDB_NAME = "casserole-write";
const IDB_STORE = "documents";

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onblocked = () => reject(new Error("indexedDB blocked"));
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

class IndexedDBStore implements DocumentStore {
  kind = "indexeddb";
  durability: Durability = "durable";
  constructor(private db: IDBDatabase) {}

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(IDB_STORE, mode).objectStore(IDB_STORE);
  }
  async list(): Promise<StoredDocMeta[]> {
    const all = (await idbRequest(this.tx("readonly").getAll())) as StoredDoc[];
    return all
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async load(id: string): Promise<StoredDoc | null> {
    return ((await idbRequest(this.tx("readonly").get(id))) as StoredDoc | undefined) ?? null;
  }
  async save(doc: StoredDoc): Promise<void> {
    await idbRequest(this.tx("readwrite").put(doc));
  }
  async remove(id: string): Promise<void> {
    await idbRequest(this.tx("readwrite").delete(id));
  }
}

// ---------- localStorage ----------
const LS_PREFIX = "casserole-write:v2:doc:";
const LS_INDEX = "casserole-write:v2:index";

class LocalStorageStore implements DocumentStore {
  kind = "localstorage";
  durability: Durability = "session";

  private readIndex(): StoredDocMeta[] {
    try {
      return JSON.parse(localStorage.getItem(LS_INDEX) ?? "[]") as StoredDocMeta[];
    } catch {
      return [];
    }
  }
  private writeIndex(index: StoredDocMeta[]): void {
    localStorage.setItem(LS_INDEX, JSON.stringify(index));
  }
  async list(): Promise<StoredDocMeta[]> {
    return this.readIndex().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async load(id: string): Promise<StoredDoc | null> {
    const raw = localStorage.getItem(LS_PREFIX + id);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredDoc;
    } catch {
      return null;
    }
  }
  async save(doc: StoredDoc): Promise<void> {
    localStorage.setItem(LS_PREFIX + doc.id, JSON.stringify(doc));
    const index = this.readIndex().filter((m) => m.id !== doc.id);
    index.push({ id: doc.id, title: doc.title, updatedAt: doc.updatedAt });
    this.writeIndex(index);
  }
  async remove(id: string): Promise<void> {
    localStorage.removeItem(LS_PREFIX + id);
    this.writeIndex(this.readIndex().filter((m) => m.id !== id));
  }
}

// ---------- in-memory ----------
class MemoryStore implements DocumentStore {
  kind = "memory";
  durability: Durability = "memory-only";
  private docs = new Map<string, StoredDoc>();
  async list(): Promise<StoredDocMeta[]> {
    return [...this.docs.values()]
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async load(id: string): Promise<StoredDoc | null> {
    return this.docs.get(id) ?? null;
  }
  async save(doc: StoredDoc): Promise<void> {
    this.docs.set(doc.id, { ...doc });
  }
  async remove(id: string): Promise<void> {
    this.docs.delete(id);
  }
}

// ---------- selection + legacy migration ----------
const LEGACY_KEY = "casserole-write:v1:default-doc";

function localStorageUsable(): boolean {
  try {
    const probe = "casserole-write:probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export async function openBestStore(): Promise<DocumentStore> {
  let store: DocumentStore;
  if (typeof indexedDB !== "undefined") {
    try {
      store = new IndexedDBStore(await idbOpen());
    } catch {
      store = localStorageUsable() ? new LocalStorageStore() : new MemoryStore();
    }
  } else {
    store = localStorageUsable() ? new LocalStorageStore() : new MemoryStore();
  }
  await migrateLegacy(store);
  return store;
}

/** Import the v1 single-document journal once, without destroying it on failure. */
async function migrateLegacy(store: DocumentStore): Promise<void> {
  if (!localStorageUsable()) return;
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return;
  try {
    const payload = JSON.parse(raw) as { savedAt?: string; doc?: unknown };
    if (!payload.doc) return;
    const id = `migrated-${Date.now().toString(36)}`;
    await store.save({
      id,
      title: "Recovered document",
      updatedAt: payload.savedAt ?? new Date().toISOString(),
      doc: payload.doc,
    });
    localStorage.removeItem(LEGACY_KEY); // only after the new save succeeded
  } catch {
    /* unreadable legacy journal: leave it in place for manual recovery */
  }
}

export function newDocId(): string {
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
