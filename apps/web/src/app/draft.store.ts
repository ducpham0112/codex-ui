import { Injectable } from "@angular/core";
import { openBrowserDatabase } from "./browser-database";
@Injectable({ providedIn: "root" })
export class DraftStore {
  private readonly db = openBrowserDatabase();
  async get(key: string): Promise<string> { const db = await this.db; return new Promise((resolve, reject) => { const request = db.transaction("drafts").objectStore("drafts").get(key); request.onsuccess = () => resolve(request.result ?? ""); request.onerror = () => reject(request.error); }); }
  async set(key: string, value: string): Promise<void> { const db = await this.db; return new Promise((resolve, reject) => { const request = db.transaction("drafts", "readwrite").objectStore("drafts").put(value, key); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); }); }
}
