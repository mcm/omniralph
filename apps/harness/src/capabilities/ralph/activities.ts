import type { RalphActivity } from "@omniralph/shared";
import { z } from "zod";
import { postJson, type FetchFn } from "../../api.js";
import type { Logger } from "../../logger.js";
import type { SessionEvent } from "./session.js";

const MAX_BODY = 10_000;
const MAX_PARAMETER = 500;

/** Tool calls that aren't worth showing (the plan in Linear already tracks progress). */
const SKIPPED_TOOLS = new Set(["TodoWrite"]);

/** Input fields that say best what a tool call does, in order of preference. */
const PARAMETER_KEYS = [
  "command",
  "file_path",
  "notebook_path",
  "path",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
  "skill",
];

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A one-line description of a tool call's input (e.g. the command it runs). */
export function toolParameter(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  for (const key of PARAMETER_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) return clip(value.trim(), MAX_PARAMETER);
  }
  const json = JSON.stringify(input);
  return json === "{}" ? "" : clip(json, MAX_PARAMETER);
}

/**
 * The activity a session event becomes in the Linear agent session: Claude's
 * text a thought, a tool call an ephemeral action (`TodoWrite` none).
 */
export function activityFor(event: SessionEvent): RalphActivity | undefined {
  if (event.type === "text") {
    const body = event.text.trim();
    return body ? { type: "thought", body: clip(body, MAX_BODY), ephemeral: false } : undefined;
  }
  if (SKIPPED_TOOLS.has(event.name)) return undefined;
  return {
    type: "action",
    body: clip(event.name, MAX_BODY),
    parameter: toolParameter(event.input),
    ephemeral: true,
  };
}

export interface ActivityRelayOptions {
  server: string;
  jobId: string;
  /** The job's current token (`run:activity` scope). */
  jobToken: () => string;
  logger: Logger;
  fetch?: FetchFn;
}

/**
 * Posts a job's activities to `POST /api/harness/jobs/{id}/activities`, one at
 * a time and in order. A failed post is logged and dropped: activities are
 * informational and never fail the job.
 */
export class ActivityRelay {
  private chain: Promise<void> = Promise.resolve();
  private readonly url: string;

  constructor(private readonly options: ActivityRelayOptions) {
    this.url = `${options.server}/api/harness/jobs/${encodeURIComponent(options.jobId)}/activities`;
  }

  post(activity: RalphActivity): void {
    this.chain = this.chain.then(async () => {
      try {
        await postJson(
          this.options.fetch ?? fetch,
          this.url,
          activity,
          z.unknown(),
          this.options.jobToken(),
        );
      } catch (error) {
        this.options.logger.warn(
          { err: error, type: activity.type },
          "relaying an activity failed",
        );
      }
    });
  }

  /** Relays a session event, if it becomes an activity. */
  event(event: SessionEvent): void {
    const activity = activityFor(event);
    if (activity) this.post(activity);
  }

  /** Resolves once every activity posted so far was sent (or dropped). */
  flush(): Promise<void> {
    return this.chain;
  }
}
