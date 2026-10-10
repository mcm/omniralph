import "server-only";
import { getDb } from "@/lib/db";
import { PostgresDispatcher, type JobDispatcher } from "./dispatcher";

export {
  PostgresDispatcher,
  type DispatchedJob,
  type DispatchJobInput,
  type JobDispatcher,
} from "./dispatcher";

let dispatcher: JobDispatcher | undefined;

/** The control panel's job dispatcher (Postgres), created on first use. */
export function getDispatcher(): JobDispatcher {
  dispatcher ??= new PostgresDispatcher({ db: getDb() });
  return dispatcher;
}
