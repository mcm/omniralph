import { sprintActionHandler } from "../../sprint-action";

/**
 * Starts a draft sprint (admins): it runs, and its first epic starts as Start epic starts it.
 * A refused start pauses the sprint with the reason. 409 unless it's a draft, 400 without epics.
 */
export const POST = sprintActionHandler("start");
