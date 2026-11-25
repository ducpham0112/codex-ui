import { expect, it } from "vitest";
import { ApprovalPreference } from "./approval-preference";

it("remembers a default for new sessions without applying it to existing sessions", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const preference = new ApprovalPreference(storage);
  preference.select("existing", "never");
  expect(preference.forNewSession()).toBe("project");
  preference.remember(true, "never");
  const reopened = new ApprovalPreference(storage);
  expect(reopened.forNewSession()).toBe("never");
  expect(reopened.forSession("existing")).toBe("project");
  expect(reopened.isRemembered("project")).toBe(false);
  expect(reopened.isRemembered("never")).toBe(true);
  reopened.select("new", reopened.forNewSession());
  reopened.remember(false, "never");
  expect(reopened.forSession("new")).toBe("never");
  expect(new ApprovalPreference(storage).forNewSession()).toBe("project");
});
