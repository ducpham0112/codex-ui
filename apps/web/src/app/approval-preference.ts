export type ApprovalChoice = "project" | "never";

const storageKey = "codex.newSessionApproval";

export class ApprovalPreference {
  private readonly sessions = new Map<string, ApprovalChoice>();

  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {}

  forNewSession(): ApprovalChoice {
    return this.storage.getItem(storageKey) === "never" ? "never" : "project";
  }

  forSession(threadId: string): ApprovalChoice {
    return this.sessions.get(threadId) ?? "project";
  }

  select(threadId: string, choice: ApprovalChoice): void {
    this.sessions.set(threadId, choice);
  }

  isRemembered(choice: ApprovalChoice): boolean {
    return this.storage.getItem(storageKey) === choice;
  }

  remember(enabled: boolean, choice: ApprovalChoice): void {
    if (enabled) this.storage.setItem(storageKey, choice);
    else this.storage.removeItem(storageKey);
  }
}
