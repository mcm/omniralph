/** The route segment as an ID (links encode the colon of `builtin:` IDs); malformed escapes match nothing. */
export function decodeId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
