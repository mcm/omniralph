/**
 * Email-domain rules shared by the server and the browser (`@omniralph/db/domains`): no
 * database imports.
 */

/** Domains are stored lower-cased, without a leading `@`. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, "");
}

const DOMAIN_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Whether `domain` (normalized) is a syntactically valid domain name: at least two
 * dot-separated labels of letters, digits and inner hyphens, a non-numeric top-level
 * label, at most 253 characters.
 */
export function isValidDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) return false;
  return !/^[0-9]+$/.test(labels[labels.length - 1]!);
}
