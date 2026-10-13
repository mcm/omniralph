/** What the card offers: only the providers (and dev sign-in) that are actually there. */
export function signInDescription(providerNames: string[], devSignIn: boolean): string {
  const access = "Access is limited to approved team members.";
  if (providerNames.length > 0) {
    const names =
      providerNames.length === 1
        ? providerNames[0]
        : `${providerNames.slice(0, -1).join(", ")} or ${providerNames.at(-1)}`;
    return `Use your ${names} account. ${access}`;
  }
  if (devSignIn) return `Sign in with the email of an existing user (development only). ${access}`;
  return "No sign-in method is set up on this server yet.";
}
