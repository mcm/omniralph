"use client";

import { BrandMark, Button, buttonClassName } from "@omniralph/ui";

/** Why Connect GitHub is disabled when the server has no GitHub App. */
export const GITHUB_NOT_CONFIGURED = "The GitHub App isn't configured";

export interface ConnectGitHubButtonProps {
  /**
   * Our install route for the organization (`githubInstallPath` from
   * `GET /api/ui/repositories/setup`): null when the GitHub App isn't configured,
   * undefined while it loads.
   */
  installPath: string | null | undefined;
  className?: string;
}

/**
 * "Connect GitHub": goes to the GitHub App's installation, which comes back to the
 * callback with the new connection. Disabled, with the reason as its tooltip, when the
 * server has no GitHub App. Built once for every place that connects GitHub.
 */
export function ConnectGitHubButton({ installPath, className }: ConnectGitHubButtonProps) {
  const label = (
    <>
      <span className="or-btn__icon" aria-hidden="true">
        <BrandMark brand="github" />
      </span>
      Connect GitHub
    </>
  );
  if (installPath) {
    // A full page load: the install route redirects to GitHub.
    return (
      <a
        className={buttonClassName("outline", "md", "or-btn--with-icon", className)}
        href={installPath}
      >
        {label}
      </a>
    );
  }
  return (
    <Button
      className={className}
      disabled
      disabledReason={installPath === null ? GITHUB_NOT_CONFIGURED : undefined}
    >
      {label}
    </Button>
  );
}
