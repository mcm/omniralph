import { sprintActionHandler } from "../../sprint-action";

/** Cancels a sprint that isn't over (admins): no epic starts any more; running ones carry on. */
export const POST = sprintActionHandler("cancel");
