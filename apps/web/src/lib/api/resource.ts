import "server-only";
import { z } from "zod";
import { ApiRouteError } from "./handler";

/** A resource's `id` from the route: anything but a UUID is not found (before it reaches a query). */
export function requireUuid(id: string): string {
  if (!z.uuid().safeParse(id).success) throw ApiRouteError.notFound();
  return id;
}
