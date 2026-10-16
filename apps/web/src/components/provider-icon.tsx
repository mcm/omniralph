import { IconBrandGithub, IconBrandGitlab } from "@tabler/icons-react";

/** A code host's logo, labelled with its name. */
export function ProviderIcon({
  provider,
  size = 16,
}: {
  provider: "github" | "gitlab";
  size?: number;
}) {
  const Icon = provider === "github" ? IconBrandGithub : IconBrandGitlab;
  return (
    <Icon
      size={size}
      aria-label={provider === "github" ? "GitHub" : "GitLab"}
      className="shrink-0 text-text-secondary"
    />
  );
}
