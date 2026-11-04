<!-- Generated from the omniralph repo (packages/planning/src/plugin, built by scripts/build-prd-plugin.ts). Do not edit by hand: change it in the omniralph repo, and CI publishes it here. -->

# Mode: prfaq

You are drafting a feature's PRFAQ with the person: the feature told from the
side of the people who will use it, as if it had already shipped. It is where
a feature starts, before its Plan. The PRFAQ rule below is its format; it is
flexible, so follow the person's own structure when they have one.

If the invocation included a `context`, treat it as the feature's background.
If it didn't, ask what the feature is before going further.

---

## Step 1: Find the feature

Work out where the PRFAQ goes before drafting it.

**The Omniralph API is configured** when the session has both the
`OMNIRALPH_URL` (the control panel's address, e.g.
`https://omniralph.example.com`) and `OMNIRALPH_API_TOKEN` environment
variables and a shell to call it from (Claude Code). Check with
`test -n "$OMNIRALPH_URL" && test -n "$OMNIRALPH_API_TOKEN" && echo configured`,
never by printing the token. Send every request with
`-H "Authorization: Bearer $OMNIRALPH_API_TOKEN"`, and JSON bodies with
`-H "Content-Type: application/json"`. When it is configured:

1. List the features: `GET $OMNIRALPH_URL/api/ui/features` answers
   `{ "features": [{ "id", "name", "status", "repository" }] }`, newest first.
2. Ask which feature the PRFAQ is for, with the features in `planning` as
   lettered options and a last option to create a new one. To create one, ask
   for its name (and its repo, if the context names one) and send
   `POST $OMNIRALPH_URL/api/ui/features` with `{ "name": "…" }`; it answers
   `{ "ok": true, "feature": { "id", … } }`. An `archived` feature takes no
   new versions: offer to create a new feature instead.
3. Load the current PRFAQ:
   `GET $OMNIRALPH_URL/api/ui/features/<id>/documents/prfaq` answers
   `{ "version", "body" }`, version `0` and an empty body when it was never
   saved. Remember the version: the save sends it back. A non-empty body is the
   person's draft: revise it rather than starting over, and keep their
   structure and wording where it still holds.

If the API answers 401 or 403, the token is missing, expired or not allowed:
say so, and carry on without the API. Any other failure: show the status and
the `error` of the JSON answer, and ask whether to retry or carry on without
the API.

**The Omniralph API is not configured** (or the person chose to carry on
without it): say that you'll produce the PRFAQ for them to paste into the
feature's PRFAQ in the Omniralph control panel (**Features**, then the
feature). Ask whether they already have a draft, and if so, ask them to paste
it so you revise it rather than starting over.

## Step 2: Clarifying questions

Ask 3–5 essential questions where the context leaves the feature unclear,
with lettered options and adaptive questioning (see `common.md`):

- **Who:** Who will use it, and what do they do today instead?
- **Problem:** What is painful about that, and why does it matter now?
- **Promise:** What changes for them when it ships, in their words?
- **Edges:** What will people ask that the feature doesn't do?
- **Success metrics:** Do they want the optional section, and if so, how will
  they judge the feature once it ships?

Don't re-ask what the context or an existing draft already answers: confirm
your understanding instead.

## Step 3: Draft the PRFAQ

Write it by the PRFAQ rule: the press release, then the FAQ, then the success
metrics only if the person wants them. Keep it short and concrete, in the
users' language. Settle every FAQ answer with the person; never leave a
placeholder or a question unanswered.

## Step 4: Review and revise

Show the whole draft, ask what to change, and revise until the person is happy
with it. Point out where the press release promises something the FAQ
contradicts, or where an answer is vague.

## Final step: save the PRFAQ

Have the person review the whole PRFAQ and confirm it is ready to save.
Only after they confirm:

**With the Omniralph API**, save it as the feature's new version:
`PUT $OMNIRALPH_URL/api/ui/features/<id>/documents/prfaq` with
`{ "body": "<the PRFAQ as Markdown>", "baseVersion": <the version you loaded> }`.
Write the PRFAQ to a file and build the JSON with a tool that escapes it,
e.g. `jq -n --rawfile body prfaq.md --argjson baseVersion <version> '{body: $body, baseVersion: $baseVersion}'`,
never by pasting the text into a quoted string. Earlier versions are kept, so
a save never loses the person's work.

- `{ "ok": true, "document": { "version" } }`: tell the person the version
  saved.
- 409 with `"code": "stale_version"`: someone saved a later version while you
  were drafting. Load it again, show the person what changed, fold their
  choice into the draft and save against the new version. Never overwrite it
  without asking.
- 409 with `"code": "archived"`: the feature was archived. Say so and offer
  to create a new feature for it.
- Any other failure: show the status and `error`, then give the person the
  PRFAQ to paste instead.

**Without the Omniralph API**, give the person the whole PRFAQ as one
Markdown block, ready to paste into the feature's PRFAQ in the control
panel, and tell them where it goes.

Write nothing to Linear: a PRFAQ is a feature's document, not an
issue.

When it is saved or handed over, suggest the next step: drafting the feature's
Plan with `/omniralph-prd plan`.

## Checklist before saving

- [ ] Found the feature through the Omniralph API, or told the person they'll
      paste the PRFAQ themselves
- [ ] Revised the existing draft rather than replacing it, if there was one
- [ ] Asked clarifying questions with lettered options
- [ ] A press release and an FAQ, in the person's structure if they have one
- [ ] Every FAQ answer settled with the person; no placeholders
- [ ] Success metrics only if the person wanted them, and nowhere but their
      own section
- [ ] No implementation detail, epics or tasks
- [ ] The person confirmed before saving

---

## PRFAQ

A PRFAQ tells the feature from the side of the people who will use it, as if it had already shipped: a press release, then the questions people would ask about it, answered. It decides what the feature is and why it matters, not how it is built.
- **Flexible format.** The template below is a starting point, not a schema. Keep the person's own structure when they have one: rename, drop, reorder or add sections as the feature needs. Nothing checks its headings.
- **Press release.** A headline and a one-sentence subheading, then the problem, the solution in the users' words, a quote and how to get started. Short and concrete: a page, not a spec.
- **FAQ.** The questions users would ask, then the questions the team building or supporting it would ask (cost, risk, what it replaces, what it leaves out), each with a direct answer. An answer nobody has yet is a question to settle with the person, not a placeholder.
- **Success metrics** (optional): see the Success metrics rule.
- No implementation detail beyond what a user would notice, no epics and no tasks: those belong in the Plan.

```markdown
# [Headline: the feature in one line, as its users would say it]

[Subheading: who it is for and what they get, in one sentence.]

## Press release

[The problem: who has it today and why it matters.]

[The solution: what changes for them, in their words.]

[A quote from someone who would use it.]

[How to get started.]

## FAQ

### Users

**[A question a user would ask.]**
[Its answer.]

### Internal

**[A question the team building or supporting it would ask: cost, risk, what it replaces.]**
[Its answer.]

## Success metrics

[Optional: how the people planning the feature will judge it once it ships.]
```

---

## Success metrics

A PRFAQ or a Plan may have a `## Success metrics` section; it is optional, and a document without one is complete.
- Success metrics are for people: how those planning the feature will judge it once it ships, such as adoption, time saved or fewer support requests.
- They never reach a run. Sharding the Plan into epics leaves them out, no epic requirement or task done criterion restates them, and no agent's checks measure them.
- Don't invent metrics the person didn't ask for. Offer the section once; if they don't want it, leave it out.
