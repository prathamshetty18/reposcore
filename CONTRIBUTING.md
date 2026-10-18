# Contributing to RepoJudge

Thank you for considering contributing! Please read this guide before opening issues or pull requests.

---

## Code of Conduct

This project follows the [MLH Code of Conduct](https://github.com/MLH/mlh-policies/blob/main/code-of-conduct.md). By participating you agree to abide by its terms.

---

## Getting Started

```bash
git clone https://github.com/prathamshetty18/reposcore.git
cd reposcore
npm install
cp .env.example .env   # fill in your tokens
npm run dev
```

Run tests before every commit:

```bash
npm test
npx tsc --noEmit
```

---

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Stable, always passing CI |
| `feat/<name>` | Feature branches — open a PR to merge into main |
| `fix/<name>` | Bug-fix branches |

---

## Pull Request Checklist

- [ ] `npm test` passes with 0 failures
- [ ] `npx tsc --noEmit` prints nothing
- [ ] No secrets or real API keys in any committed file
- [ ] No `gemini-*` model IDs in source code (only Gemma 4 via `GEMMA_MODEL` env var)
- [ ] New behaviour covered by a vitest test
- [ ] Commit messages are clear and imperative (`Add`, `Fix`, `Refactor` …)

---

## Hard Rules

1. **Model**: Only Gemma 4. Never reference a closed or proprietary model id in source code.
2. **Secrets**: Never commit `.env`. Only `.env.example` (with placeholder values) is tracked.
3. **Schema**: `src/schema.ts` is the single source of truth for data shapes. Coordinate changes with the team.
4. **No `any`**: TypeScript strict mode is enforced. `@ts-ignore` requires a comment explaining why.

---

## Reporting Issues

Open a GitHub Issue with:
- Steps to reproduce
- Expected vs actual behaviour
- Node version (`node --version`) and OS

---

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
