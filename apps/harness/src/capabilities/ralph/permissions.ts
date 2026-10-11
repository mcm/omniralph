import { randomUUID } from "node:crypto";
import { RalphPermissionAnswer } from "@omniralph/shared";
import { z } from "zod";
import { postJson, type FetchFn } from "../../api.js";
import type { Logger } from "../../logger.js";
import { toolParameter } from "./activities.js";
import type { PermissionCall } from "./session.js";

/** How long a session waits for a person to answer in Linear before the call is denied. */
export const PERMISSION_TIMEOUT_MS = 30 * 60_000;

/** How often the answer is polled for. */
export const PERMISSION_POLL_INTERVAL_MS = 5_000;

const REQUEST_TIMEOUT_MS = 30_000;

export interface PermissionRelayOptions {
  server: string;
  jobId: string;
  /** The job's current token (`ralph:activity` scope). */
  jobToken: () => string;
  logger: Logger;
  fetch?: FetchFn;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/** Waits `ms`, or until the signal fires (then rejects with its reason). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Asks a person in the run's Linear session to approve a tool call that the
 * repository's Claude Code settings `ask` about (request sessions bypass
 * everything else): `POST /api/harness/jobs/{id}/permissions`, then polls
 * `GET …/permissions/{requestId}` until someone answers. With no answer
 * within `timeoutMs` (or when the session ends) the call is denied and the
 * question closed (`DELETE`). One question at a time: concurrent calls wait
 * their turn. Any failure to ask or to read the answer denies the call.
 */
export class PermissionRelay {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly base: string;

  constructor(private readonly options: PermissionRelayOptions) {
    this.base = `${options.server}/api/harness/jobs/${encodeURIComponent(options.jobId)}/permissions`;
  }

  /** Whether the call may run. */
  ask(call: PermissionCall, signal: AbortSignal): Promise<boolean> {
    const turn = this.chain.then(() => this.askNow(call, signal));
    this.chain = turn.catch(() => {});
    return turn;
  }

  private async askNow(call: PermissionCall, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const log = this.options.logger.child({ tool: call.tool });
    const requestId = randomUUID();
    const timeoutMs = this.options.timeoutMs ?? PERMISSION_TIMEOUT_MS;
    try {
      await postJson(
        this.options.fetch ?? fetch,
        this.base,
        {
          requestId,
          tool: call.tool,
          detail: toolParameter(call.input),
          ...(call.reason && { reason: call.reason.slice(0, 1000) }),
          timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
        },
        z.unknown(),
        this.options.jobToken(),
      );
    } catch (error) {
      log.warn({ err: error }, "asking for a tool permission failed; denying the call");
      return false;
    }
    log.info({ requestId }, "asked for a tool permission in Linear");

    const deadline = Date.now() + timeoutMs;
    const interval = this.options.pollIntervalMs ?? PERMISSION_POLL_INTERVAL_MS;
    let failures = 0;
    try {
      while (Date.now() < deadline) {
        await sleep(Math.min(interval, Math.max(0, deadline - Date.now())), signal);
        let answer: RalphPermissionAnswer;
        try {
          answer = await this.read(requestId);
          failures = 0;
        } catch (error) {
          // A blip shouldn't deny the call; a control panel that stays down does.
          if (++failures >= 10) throw error;
          continue;
        }
        if (answer.status === "pending") continue;
        log.info({ requestId, status: answer.status }, "tool permission answered");
        return answer.status === "allowed";
      }
      log.info({ requestId }, "nobody answered the tool permission in time; denying the call");
    } catch (error) {
      if (!signal.aborted) log.warn({ err: error }, "reading a tool permission failed; denying it");
    }
    await this.close(requestId, log);
    return false;
  }

  private async read(requestId: string): Promise<RalphPermissionAnswer> {
    const res = await (this.options.fetch ?? fetch)(
      `${this.base}/${encodeURIComponent(requestId)}`,
      {
        headers: { authorization: `Bearer ${this.options.jobToken()}` },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`reading the permission answer failed with ${res.status}`);
    return RalphPermissionAnswer.parse(await res.json());
  }

  /** Closes the question (best effort), so a late answer isn't taken for a live one. */
  private async close(requestId: string, log: Logger): Promise<void> {
    try {
      await (this.options.fetch ?? fetch)(`${this.base}/${encodeURIComponent(requestId)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${this.options.jobToken()}` },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      log.warn({ err: error }, "closing a tool permission question failed");
    }
  }
}
