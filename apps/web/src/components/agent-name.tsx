import { EmptyValue } from "@/components/empty-value";
import { Link } from "@/components/link";

/** The agent that ran something: linked to its page for admins, plain text for members. */
export function AgentName({
  agent,
  isAdmin,
}: {
  agent: { id: string; name: string } | null;
  isAdmin: boolean;
}) {
  if (!agent) return <EmptyValue />;
  return isAdmin ? (
    <Link href={`/harnesses/${agent.id}`} className="list-text list-text-primary">
      {agent.name}
    </Link>
  ) : (
    <span className="list-text">{agent.name}</span>
  );
}
