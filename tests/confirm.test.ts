import { describe, expect, it, vi } from "vitest";
import {
  confirmAction,
  getPendingConfirm,
  onConfirmRequest,
  resolveConfirm,
} from "../src/confirm";

describe("confirmAction", () => {
  it("auto-confirms when no UI listener is attached (headless)", async () => {
    await expect(
      confirmAction({ title: "Remove?" })
    ).resolves.toBe(true);
  });

  it("waits for the UI resolution", async () => {
    const listener = vi.fn();
    const unsubscribe = onConfirmRequest(listener);

    const promise = confirmAction({
      title: "Remove session?",
      description: "page name",
      danger: true,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPendingConfirm()?.title).toBe("Remove session?");
    expect(getPendingConfirm()?.danger).toBe(true);

    resolveConfirm(false);
    await expect(promise).resolves.toBe(false);
    expect(getPendingConfirm()).toBeNull();

    unsubscribe();
  });

  it("notifies the UI when the request is cleared", async () => {
    const listener = vi.fn();
    const unsubscribe = onConfirmRequest(listener);

    const promise = confirmAction({ title: "Confirm?" });
    resolveConfirm(true);
    await expect(promise).resolves.toBe(true);

    expect(listener).toHaveBeenNthCalledWith(2, null);
    unsubscribe();
  });

  it("cancels the previous request when a new one arrives", async () => {
    const unsubscribe = onConfirmRequest(() => {});

    const first = confirmAction({ title: "first" });
    const second = confirmAction({ title: "second" });

    await expect(first).resolves.toBe(false);
    expect(getPendingConfirm()?.title).toBe("second");
    resolveConfirm(true);
    await expect(second).resolves.toBe(true);

    unsubscribe();
  });

  it("ignores resolution without a pending request", () => {
    expect(() => resolveConfirm(true)).not.toThrow();
  });

  it("unsubscribes cleanly", async () => {
    const unsubscribe = onConfirmRequest(() => {});
    unsubscribe();
    await expect(confirmAction({ title: "x" })).resolves.toBe(true);
  });
});
