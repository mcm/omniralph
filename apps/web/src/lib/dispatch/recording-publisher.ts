/**
 * A `QueuePublisher` for tests that records what was published instead of
 * sending it: wrap it in `VercelQueuesDispatcher` to get the real job rows and
 * topic choice (pins, target agents) without Vercel Queues.
 */
import type { JobMessage } from "@omniralph/shared";
import type { QueuePublisher } from "./dispatcher";

export interface PublishedMessage {
  topic: string;
  jobId: string;
}

export class RecordingPublisher implements QueuePublisher {
  sent: PublishedMessage[] = [];

  async send(topic: string, payload: JobMessage): Promise<{ messageId: string }> {
    this.sent.push({ topic, jobId: payload.jobId });
    return { messageId: `msg-${this.sent.length}` };
  }
}
