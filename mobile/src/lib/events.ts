type Listener = () => void;
const listeners = new Set<Listener>();

/** Notifies screens that receipts changed (saved, deleted, sync status updated). */
export function emitReceiptsChanged() {
  listeners.forEach((listener) => listener());
}

export function onReceiptsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
