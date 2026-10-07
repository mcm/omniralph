/** Parses `ALLOWED_EMAIL_DOMAINS` (comma- or whitespace-separated, optional leading `@`). */
export function parseAllowedDomains(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean),
    ),
  ];
}

/** Lower-cased domain part of an email, or `null` if it isn't a plausible address. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/** Basic shape check for emails an admin invites. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Sign-in gate: an email may sign in when its domain is exactly one of `allowedDomains`
 * (`ALLOWED_EMAIL_DOMAINS`; subdomains are not included) or it has a pending, unexpired
 * invitation to an organization (`hasPendingInvitation`). Accounts without an email are
 * always denied.
 */
export async function isEmailAllowed(input: {
  email: string | null | undefined;
  allowedDomains: readonly string[];
  hasPendingInvitation: (email: string) => boolean | Promise<boolean>;
}): Promise<boolean> {
  const email = input.email?.trim().toLowerCase();
  if (!email) return false;
  const domain = emailDomain(email);
  if (!domain) return false;
  if (input.allowedDomains.includes(domain)) return true;
  return input.hasPendingInvitation(email);
}
