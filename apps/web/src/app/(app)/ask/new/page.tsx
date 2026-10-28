import { AskNewChatPage } from "@/components/ask/ask-pages";

/** Ask › New chat (`src/components/ask`); `?repository=` preselects the repo. */
export default async function AskNewChatRoute({
  searchParams,
}: {
  searchParams: Promise<{ repository?: string | string[] }>;
}) {
  const { repository } = await searchParams;
  const repositoryId = (Array.isArray(repository) ? repository[0] : repository) || null;
  return <AskNewChatPage repositoryId={repositoryId} />;
}
