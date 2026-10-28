/** `GET /api/state`: what every page needs at once, and the nav's problem dots. */
import { useQuery } from "@tanstack/react-query";
import type { AgentUiState, NavProblem, NavProblemSection } from "../../src/ui/state.js";
import { localRequest } from "./api.js";
import { agentKeys } from "./live/keys.js";

export type { AgentUiState, NavProblem, NavProblemSection };

export function useAgentState() {
  return useQuery({
    queryKey: agentKeys.state,
    queryFn: ({ signal }) => localRequest<AgentUiState>("/api/state", { signal }),
  });
}
