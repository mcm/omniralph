import "server-only";
import { getWakePublisher } from "@/lib/ably/publisher";
import { getDb } from "@/lib/db";
import { PostgresDispatcher, type JobDispatcher } from "./dispatcher";

export {
  PostgresDispatcher,
  type DispatchedJob,
  type DispatchJobInput,
  type JobDispatcher,
} from "./dispatcher";

let dispatcher: JobDispatcher | undefined;

/** The control panel's job dispatcher (Postgres, waking agents over Ably when configured), created on first use. */
export function getDispatcher(): JobDispatcher {
  dispatcher ??= new PostgresDispatcher({ db: getDb(), wakePublisher: getWakePublisher() });
  return dispatcher;
}
