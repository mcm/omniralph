import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getRepositoryWithConnection, listRepositoryRules } from "@omniralph/db";
import { z } from "zod";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { ruleView } from "@/lib/rules/display";
import { RulesView } from "./rules-view";

export const metadata: Metadata = { title: "Repository rules · Omniralph" };

export default async function RepositoryRulesPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const db = getDb();
  const found = await getRepositoryWithConnection(db, id);
  if (!found || found.repository.disconnectedAt) notFound();
  const { repository, connection } = found;
  const rules = await listRepositoryRules(db, id);

  return (
    <RulesView
      repository={{
        id: repository.id,
        provider: repository.provider,
        fullPath: repository.fullPath,
        webUrl: repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath),
      }}
      rules={rules.map(ruleView)}
    />
  );
}
