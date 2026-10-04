import "server-only";
import { getDb } from "@/lib/db";
import { VercelQueuesDispatcher, type JobDispatcher } from "./dispatcher";

export { agentTopics, publishRegion, queueRegions } from "./config";
export {
  VercelQueuesDispatcher,
  type DispatchedJob,
  type DispatchJobInput,
  type JobDispatcher,
  type QueuePublisher,
} from "./dispatcher";
export { MAX_PROXY_BODY_BYTES, proxyQueueRequest, type QueueProxyOptions } from "./queue-proxy";

let dispatcher: JobDispatcher | undefined;

/** The control panel's job dispatcher (Vercel Queues), created on first use. */
export function getDispatcher(): JobDispatcher {
  dispatcher ??= new VercelQueuesDispatcher({ db: getDb() });
  return dispatcher;
}
