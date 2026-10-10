import "server-only";
import { getDb } from "@/lib/db";
import { PostgresDispatcher, type JobDispatcher } from "./dispatcher";

export { agentTopics, publishRegion, queueRegions } from "./config";
export {
  PostgresDispatcher,
  type DispatchedJob,
  type DispatchJobInput,
  type JobDispatcher,
} from "./dispatcher";
export { MAX_PROXY_BODY_BYTES, proxyQueueRequest, type QueueProxyOptions } from "./queue-proxy";

let dispatcher: JobDispatcher | undefined;

/** The control panel's job dispatcher (Postgres), created on first use. */
export function getDispatcher(): JobDispatcher {
  dispatcher ??= new PostgresDispatcher({ db: getDb() });
  return dispatcher;
}
