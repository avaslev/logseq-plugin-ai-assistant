// Framework-agnostic confirmation request store (F17). The UI subscribes
// with onConfirmRequest and renders the confirm/cancel card; command and
// tool code awaits confirmAction(). When no UI listener is attached
// (headless contexts, tests), confirmAction resolves to true so that
// flows do not hang.

export interface ConfirmRequest {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PendingRequest extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

let pending: PendingRequest | null = null;
const listeners = new Set<(request: ConfirmRequest | null) => void>();

function emit(): void {
  const snapshot = pending
    ? ({
        title: pending.title,
        description: pending.description,
        confirmLabel: pending.confirmLabel,
        cancelLabel: pending.cancelLabel,
        danger: pending.danger,
      } as ConfirmRequest)
    : null;
  listeners.forEach((cb) => cb(snapshot));
}

export function onConfirmRequest(
  cb: (request: ConfirmRequest | null) => void
): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getPendingConfirm(): ConfirmRequest | null {
  return pending
    ? ({
        title: pending.title,
        description: pending.description,
        confirmLabel: pending.confirmLabel,
        cancelLabel: pending.cancelLabel,
        danger: pending.danger,
      } as ConfirmRequest)
    : null;
}

export function confirmAction(spec: ConfirmRequest): Promise<boolean> {
  if (listeners.size === 0) return Promise.resolve(true);
  if (pending) pending.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending = { ...spec, resolve };
    emit();
  });
}

export function resolveConfirm(ok: boolean): void {
  if (!pending) return;
  const { resolve } = pending;
  pending = null;
  emit();
  resolve(ok);
}
