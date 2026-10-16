import type { ActionResult } from "@/lib/action-result";

/**
 * For tests: calls an `/api/ui` route handler as the panel does and answers its result as
 * the `ActionResult` of the server action it replaced (`{ ok: true, … }` on 2xx, else
 * `{ ok: false, error, fieldErrors? }`).
 */
export async function callAction<P extends Record<string, string>>(
  handler: (request: Request, route: { params: Promise<P> }) => Promise<Response>,
  method: string,
  params: P,
  body?: unknown,
): Promise<ActionResult> {
  const response = await handler(
    new Request("http://localhost/api/ui", {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  );
  const json = (await response.json()) as Record<string, unknown>;
  if (response.ok) return json as ActionResult;
  return {
    ok: false,
    error: json.error as string,
    ...(json.fieldErrors ? { fieldErrors: json.fieldErrors as Record<string, string> } : {}),
  };
}
