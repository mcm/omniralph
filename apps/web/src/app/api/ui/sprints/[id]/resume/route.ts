import { sprintActionHandler } from "../../sprint-action";

/** Resumes a paused sprint (admins): its stalled epic is retried, else its next one starts. */
export const POST = sprintActionHandler("resume");
