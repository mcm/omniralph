/** The organization has no work item tracker connected (or it was disconnected meanwhile). */
export class TrackerNotConnectedError extends Error {
  constructor(
    message = "This organization has no work item tracker connected (Settings › Connections).",
  ) {
    super(message);
    this.name = "TrackerNotConnectedError";
  }
}
