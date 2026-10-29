/**
 * Imported first by the page's entry, before any module builds a zod schema: zod compiles
 * object parsers with `new Function` when it may, and its check for that (run as a schema is
 * built) is an eval the page's CSP refuses and logs. Parse without compiling, so nothing tries.
 */
import { z } from "zod";

z.config({ jitless: true });
