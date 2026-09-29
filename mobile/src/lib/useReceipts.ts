import { useCallback, useEffect, useState } from "react";
import { getReceipt, listReceipts } from "./db";
import { onReceiptsChanged } from "./events";
import type { Receipt, ReceiptSummary } from "./types";

function loadList(onResult: (receipts: ReceiptSummary[] | null, error: string | null) => void) {
  return listReceipts()
    .then((receipts) => onResult(receipts, null))
    .catch((e) => {
      console.warn("Failed to load receipts", e);
      onResult(null, "Couldn't load your receipts.");
    });
}

export function useReceiptList() {
  const [receipts, setReceipts] = useState<ReceiptSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apply = useCallback((list: ReceiptSummary[] | null, err: string | null) => {
    if (list) setReceipts(list);
    else setReceipts((current) => current ?? []);
    setError(err);
  }, []);
  useEffect(() => {
    let active = true;
    const load = () => void loadList((list, err) => active && apply(list, err));
    load();
    const unsubscribe = onReceiptsChanged(load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [apply]);
  const reload = useCallback(() => loadList(apply), [apply]);
  return { receipts, error, reload };
}

export function useReceipt(id: string | undefined) {
  const [receipt, setReceipt] = useState<Receipt | null | undefined>(undefined);
  useEffect(() => {
    if (!id) return;
    let active = true;
    const load = () =>
      getReceipt(id)
        .then((r) => active && setReceipt(r))
        .catch(() => active && setReceipt(null));
    void load();
    const unsubscribe = onReceiptsChanged(() => void load());
    return () => {
      active = false;
      unsubscribe();
    };
  }, [id]);
  return receipt;
}
