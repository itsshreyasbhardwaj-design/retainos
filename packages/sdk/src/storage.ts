import type { StorageAdapter } from "./types.ts";

/** In-memory storage. The default in Node and in privacy-restricted browsers. */
export function memoryStorage(): StorageAdapter {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
}

/**
 * localStorage, with every access wrapped.
 *
 * Safari in private mode, blocked site data and storage-partitioned iframes all
 * make localStorage throw rather than return null, so an unguarded read would
 * crash the host application. The SDK degrades to memory instead.
 */
export function browserStorage(): StorageAdapter {
  const probe = (): Storage | null => {
    try {
      const s = globalThis.localStorage;
      if (!s) return null;
      const probeKey = "__retainos_probe__";
      s.setItem(probeKey, "1");
      s.removeItem(probeKey);
      return s;
    } catch {
      return null;
    }
  };
  const store = probe();
  if (!store) return memoryStorage();
  return {
    get: (k) => {
      try {
        return store.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        store.setItem(k, v);
      } catch {
        /* quota or policy: a lost preference is not worth breaking the page */
      }
    },
    remove: (k) => {
      try {
        store.removeItem(k);
      } catch {
        /* ignore */
      }
    },
  };
}

export function defaultStorage(): StorageAdapter {
  return typeof globalThis.localStorage !== "undefined" ? browserStorage() : memoryStorage();
}
