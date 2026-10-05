import type { JobStatus } from "../api.js";

export function JobCard({ status }: { status: JobStatus | null }) {
  if (!status) return <p>Loading…</p>;
  return (
    <section>
      <h2>Job {status.id}</h2>
      <p>
        {status.state} ({Math.round(status.progress * 100)}%)
      </p>
    </section>
  );
}
