import { normalizeGitLabUrl } from "@omniralph/scm";

export interface GitLabConnectForm {
  baseUrl: string;
  token: string;
}

export interface GitLabConnectInput {
  baseUrl: string;
  token: string;
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Validates the Connect GitLab form. Returns the cleaned input or an error message. */
export function parseGitLabConnectForm(
  form: GitLabConnectForm,
): { ok: true; input: GitLabConnectInput } | { ok: false; error: string } {
  const baseUrl = normalizeGitLabUrl(form.baseUrl);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, error: "Enter the GitLab URL, e.g. https://gitlab.com." };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost(url.hostname))) {
    return { ok: false, error: "The GitLab URL must use https." };
  }
  if (url.search || url.hash || url.username || url.password) {
    return {
      ok: false,
      error: "Enter just the GitLab instance URL, e.g. https://gitlab.example.com.",
    };
  }

  const token = form.token.trim();
  if (!token) return { ok: false, error: "Enter the bot's access token." };

  return {
    ok: true,
    input: { baseUrl: url.origin + url.pathname.replace(/\/+$/, ""), token },
  };
}
