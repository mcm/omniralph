export interface Contact {
  email: string;
  name: string;
  company: string | null;
}

export interface ContactStore {
  /** Inserts or updates the contact with this email. */
  upsert(contact: Contact): Promise<void>;
}
