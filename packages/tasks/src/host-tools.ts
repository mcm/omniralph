import { z } from "zod";

/**
 * A host tool's name: software a harness owner installs by hand (e.g.
 * `opengrep`), in the organization's catalog and looked up on the harness's `PATH`.
 */
export const HOST_TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const HostToolName = z.string().regex(HOST_TOOL_NAME_PATTERN);
