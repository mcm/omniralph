import { sprintActionHandler } from "../../sprint-action";

/** Pauses a running sprint (members): no new epic starts; a running one carries on. */
export const POST = sprintActionHandler("pause");
