import { sprintActionHandler } from "../../sprint-action";

/** Pauses a running sprint (admins): no new epic starts; a running one carries on. */
export const POST = sprintActionHandler("pause");
