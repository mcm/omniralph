export interface JobStatus {
  id: string;
  state: "queued" | "running" | "done" | "failed";
  progress: number;
}

export async function fetchJobStatus(jobId: string, signal?: AbortSignal): Promise<JobStatus> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { signal });
  if (!response.ok) throw new Error(`Job status request failed: ${response.status}`);
  return (await response.json()) as JobStatus;
}
