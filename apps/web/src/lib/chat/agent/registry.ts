import { readTools } from "./read-tools";
import type { ChatToolRegistry } from "./tools";

/** The control-panel agent's tools (names are what the model sees). */
export const chatTools: ChatToolRegistry = { ...readTools };
