let database: Promise<IDBDatabase> | undefined;

/** Drafts and history share a schema and connection so upgrades cannot block each other. */
export function openBrowserDatabase(): Promise<IDBDatabase> {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("codex-control", 2);
    request.onupgradeneeded = () => {
      for (const name of ["drafts", "thread-history"]) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
