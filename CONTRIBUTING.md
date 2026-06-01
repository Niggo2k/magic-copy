# Contributing to Magic Copy

Thanks for your interest in improving Magic Copy! This document describes how to
propose changes, how branches and commits should be named, and how pull requests
are reviewed and merged.

By participating in this project you agree to keep interactions respectful and
constructive.

---

## Getting started

**Prerequisites**

- [Node.js](https://nodejs.org) 18+
- [Bun](https://bun.sh) (the project uses `bun.lock`; `npm` also works but Bun is preferred)

**Set up the project**

```bash
git clone https://github.com/Niggo2k/magic-copy.git
cd magic-copy
bun install
bun run dev      # watch mode with hot reload
```

See the [README](./README.md) for how to load the unpacked extension in Chrome.

---

## Branching rules

- **Never commit directly to `master`.** All changes land through a pull request.
- Always branch from an up-to-date `master`:
  ```bash
  git checkout master
  git pull origin master
  git checkout -b feature/short-description
  ```
- **Branch naming** — preferred form is `type/short-description`, where `type` is one of:

  | Type | Use for |
  |------|---------|
  | `feature/` | new functionality |
  | `fix/` | bug fixes |
  | `docs/` | documentation only |
  | `chore/` | tooling, deps, config, build |
  | `refactor/` | internal change with no behavior change |

  The existing `{github-username}/{short-description}` style (e.g.
  `Niggo2k/plasmo-inline-css-copy`) is also accepted. Use kebab-case and keep the
  description short and meaningful.
- Keep each branch focused on **one logical change**. Open separate branches/PRs
  for unrelated work.

---

## Commit rules

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): subject

optional body explaining the why, not just the what
```

- **Allowed types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `build`, `ci`.
- **Subject:** imperative mood ("add", not "added"/"adds"), ≤ 72 characters, no trailing period.
- **Scope** is optional (e.g. `feat(sidebar): ...`).
- Use the body to explain *why* a change was made when it isn't obvious from the diff.

Examples:

```
feat: capture pseudo-states via CDP for live preview
fix(cdp): release debugger session after capture
docs: document branch and merge rules
```

---

## Pull request rules

1. Push your branch and open a PR against **`master`**.
2. Fill out the [pull request template](./.github/pull_request_template.md) completely.
3. Link related issues in the description (e.g. `Closes #123`).
4. Keep PRs **small and focused** — easier to review, faster to merge.
5. Before requesting review, make sure the checks pass locally:
   ```bash
   bun run typecheck
   bun run build
   ```
6. CI (build + typecheck) must be **green**.
7. At least **one approving review** is required before merge. (The maintainer may
   self-merge when no other reviewer is available.)
8. Resolve all review threads before merging.

---

## Merge rules

- **Squash & merge only.** `master` stays linear and each PR becomes a single commit.
- The squash commit subject **must** follow Conventional Commits (it becomes the
  permanent history entry).
- **Delete the branch** after merging.
- Do not use merge commits or rebase-merge for `master`.

---

## Code style

- TypeScript in strict mode — no `any` escape hatches unless unavoidable and commented.
- Follow the patterns already present in the codebase (see the Project Structure
  table in the [README](./README.md)).
- No linter or formatter is configured yet; match the surrounding code's style.

---

## Recommended branch protection (maintainers)

These are repository **Settings**, not files — enable them on GitHub under
*Settings → Branches* (rule for `master`) and *Settings → General → Pull Requests*:

- Require a pull request before merging (with at least 1 approval).
- Require the **CI** status check to pass before merging.
- Allow **squash merging only**; disable merge commits and rebase merging.
- Automatically delete head branches after merge.
- Optionally require branches to be up to date before merging.
