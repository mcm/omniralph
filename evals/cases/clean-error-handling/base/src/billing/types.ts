export interface Invoice {
  id: string;
  accountId: string;
  amountCents: number;
  issuedAt: string;
}

export interface BillingApi {
  listInvoicesSince(accountId: string, since: string | null): Promise<Invoice[]>;
}

export interface Ledger {
  /** Records an invoice; throws on validation or storage errors. */
  record(invoice: Invoice): Promise<void>;
}

export interface SyncState {
  lastSyncedAt(accountId: string): Promise<string | null>;
  markSynced(accountId: string, at: string): Promise<void>;
}
