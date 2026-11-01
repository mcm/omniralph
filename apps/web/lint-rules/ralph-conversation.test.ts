import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noDirectSessionWrite } from "./ralph-conversation.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});

ruleTester.run("no-direct-session-write", noDirectSessionWrite, {
  valid: [
    "await conversationFor(run, deps).post(message);",
    "tracker.createIssue({});",
    "const { createActivity } = tracker.sessions;",
    "plans.updatePlan(id, plan);",
  ],
  invalid: [
    { code: "await tracker.sessions.createActivity({});", errors: [{ messageId: "direct" }] },
    { code: "await tracker.sessions?.createActivity({});", errors: [{ messageId: "direct" }] },
    { code: "sessions.updatePlan(id, plan);", errors: [{ messageId: "direct" }] },
    { code: "const add = client.sessions.addExternalUrl;", errors: [{ messageId: "direct" }] },
  ],
});
