const expiry = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** A review link's expiry day, as the public page and the Share review link sheet show it: "Nov 23". */
export function formatShareExpiry(expiresAt: Date | string): string {
  return expiry.format(typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt);
}
