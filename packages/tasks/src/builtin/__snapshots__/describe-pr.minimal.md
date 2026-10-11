The branch `chat/bump-node` in this git worktree is ready for a merge request into `develop`. It implements "Bump the Node version" (chat-1).

## Write the title and description
1. Study what actually changed: `git log --reverse --format='%s%n%b' origin/develop..HEAD` and `git diff origin/develop...HEAD` (use `develop` instead of `origin/develop` if that ref doesn't exist), reading files where the diff alone isn't clear.
2. Write a title and description for the merge request that a reviewer with no access to the issue tracker can follow:
   - Title: one line, imperative mood, at most 72 characters, summarising the change itself. No issue identifiers or prefixes.
   - Description (markdown): open with a short summary of what the change delivers and why. Then the notable changes, grouped by area, in a few bullets.
   - Add a **Stories** section listing every story above as `- <identifier>: <title>`, with the identifier exactly as given.
   - Add a **Verification** section saying how the change was verified (the quality gates above, if any, tests the stories added), without claiming checks that didn't run.
   - Add a **Breaking changes** section if behaviour, configuration, APIs or data formats change incompatibly, saying what users must do. Omit it otherwise.
   - Add a **Decisions** section for judgement calls, trade-offs or deviations from the request that a reviewer should know about. Omit it if there were none.
   - Don't describe the development process or the progress log, and don't link the issue tracker; that is added for you.
   - Be concrete and concise; don't pad with generic statements or restate the diff line by line.
3. Don't change any files.

Report them as the `title` and the markdown `body` of your structured result.