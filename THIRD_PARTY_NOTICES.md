# Third-party notices

Omniralph includes code adapted from the following third-party projects.

## claude-skills

- Source: https://github.com/alirezarezvani/claude-skills (commit `19392f7a08264ed00486a251f5b2098321771f94`)
- Used in:
  - `packages/engine/src/riskScan.ts`, a TypeScript port of
    `engineering-team/skills/code-reviewer/scripts/pr_analyzer.py` (file risk
    categories, risk patterns and complexity score)
  - `packages/engine/src/rubric/universal.md` and
    `packages/engine/src/rubric/languages/*.md`, adapted from
    `engineering-team/skills/code-reviewer/rules/universal.md` and
    `engineering-team/skills/code-reviewer/languages/*.md` (the "Flag …" rules of
    the security, concurrency, resource, exception and performance sections; the
    style/idiom sections were dropped, and the correctness, breaking-change,
    tests, probing-question, do-not-report and evidence sections are our own)
- License: MIT

```
MIT License

Copyright (c) 2025 Alireza Rezvani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
