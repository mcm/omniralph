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
    "linear.createIssue({});",
    "const { createActivity } = linear;",
  ],
  invalid: [
    { code: "await linear.createActivity({});", errors: [{ messageId: "direct" }] },
    { code: "client.updateSessionPlan(id, plan);", errors: [{ messageId: "direct" }] },
    { code: "const add = client.addSessionExternalUrl;", errors: [{ messageId: "direct" }] },
  ],
});
