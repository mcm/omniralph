import type { Contact } from "./store.js";

export interface ContactRow {
  Email: string;
  Name: string;
  Company?: string;
}

export function normalize(row: ContactRow): Contact {
  return {
    email: row.Email.trim().toLowerCase(),
    name: row.Name.trim(),
    company: row.Company?.trim() || null,
  };
}
