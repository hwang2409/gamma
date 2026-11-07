import { expect, test } from "bun:test";
import { createReceiptStore } from "../src/receipts";

test("receipts are run-local, dismissible, and page-memory only", () => {
  const store = createReceiptStore();
  let changes = 0;
  const unsubscribe = store.subscribe(() => changes++);
  store.set("run-a", { text: "status\nready", tone: "quiet" });
  store.set("run-b", { text: "bad command", tone: "error" });
  expect(store.get("run-a")).toEqual({ text: "status\nready", tone: "quiet" });
  expect(store.get("run-b")?.tone).toBe("error");
  store.dismiss("run-a");
  expect(store.get("run-a")).toBeNull();
  expect(changes).toBe(3);
  unsubscribe(); store.dispose();
  expect(createReceiptStore().get("run-b")).toBeNull();
});
