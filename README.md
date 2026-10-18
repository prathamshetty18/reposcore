# RepoJudge

An automated hackathon repository judge that scores public GitHub repos against structured criteria using a deterministic rules engine, optionally augmented by a provider-agnostic, free-friendly open-weight AI advisory layer (supporting **Groq**, **OpenRouter**, and **Ollama**).

---

## Problem Statement

Hackathon organizers must manually review dozens (sometimes hundreds) of submitted repositories in a short window. Scoring is inconsistent, slow, and hard to audit. RepoJudge solves this by running every repo through a transparent, reproducible pipeline that produces a structured `Scorecard` JSON — readable by humans and machines alike.

---

## Features

- **Default "Rules Only" mode** — zero AI call, no API key required, pure deterministic checks. Checks licenses, CI/CD, tests, README quality, contributors, commit activity, CoC compliance, and secret scanning with sub-second runtime.
- **Provider-agnostic AI layer** — optional second pass powered by an OpenAI-compatible chat completions interface. Presets configured for **Groq**, **OpenRouter**, and local **Ollama**.
- **User-supplied API keys** — Users can supply their own API keys via the web interface or configure them via environment variables. If neither key nor provider is configured, the UI clearly disables AI mode with an advisory message.
- **Resilient AI scoring & caching** — strictly outputs JSON `{ [criterion]: { score: 0-5, reason: "..." } }`, automatically retrying up to 3 times on invalid output with a 15-second per-call timeout. On 429 rate limits or timeouts, failed criteria are marked "not scored" rather than guessing numbers. AI verdicts are cached per repo URL + commit SHA.
- **Non-overriding advisory verdicts** — AI scoring adds qualitative depth but never overrides deterministic rule results.
- **Structured output** — every evaluation outputs a `Scorecard` object validated by Zod; safe to inspect, store, or display.

---

## Architecture

```
GitHub Repo URL
      │
      ▼
┌─────────────┐
│   Ingest    │  GitHub REST API → RepoSnapshot (owner, README, fileTree,
│  (Octokit)  │  commitSha, contributors, CI, license, CoC flags …)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Rules     │  Deterministic checks → RuleCheck[]
│   Engine    │  (license, commits, contributors, CI, README, secrets …)
└──────┬──────┘
       │   mode = "rules" (default) ────────────────────┐
       │   mode = "rules+ai"                            │
       ▼                                                │
┌─────────────┐                                         │
│  AI Judge   │  OpenAI-compatible chat completions     │
│ (Groq/Ollama│  → AIVerdict[] (score 0-5 + reason)     │
│ /OpenRouter)│  Cached per URL + commit SHA            │
└──────┬──────┘                                         │
       │                                                │
       ▼                                                ▼
┌────────────────────────────────────────────────────────┐
│                   Merge / Scorecard                    │
│  Combines rule scores + AI scores → total (out of 30) │
│  Validates with Zod → Scorecard JSON                  │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │   Express    │
                    │  REST API /  │
                    │  HTML UI     │
                    └──────────────┘
```

---

## Setup

### Prerequisites

- Node.js 20+
- A GitHub personal access token (public repo read scope; optional for low volumes, recommended to prevent GitHub rate limits)
- **Optional**: An API key from Groq or OpenRouter, or a local Ollama installation (only needed for `rules+ai` mode).

### Install

```bash
git clone https://github.com/prathamshetty18/reposcore.git
cd reposcore
npm install
```

### Configure

Copy the example environment configuration:

```bash
cp .env.example .env
```

#### Option 1: Rules Only Mode (Default — No Keys Required)
You can run the server immediately without configuring any AI keys:
```env
GITHUB_TOKEN=ghp_your_token_here
```

#### Option 2: Groq Setup (Recommended — Ultra-Fast)
1. Sign up for a free key at [console.groq.com](https://console.groq.com/).
2. In `.env`:
   ```env
   GROQ_API_KEY=gsk_your_groq_api_key_here
   AI_MODEL=llama-3.3-70b-versatile
   ```
   *(Alternatively, configure generic `AI_PROVIDER=groq`, `AI_BASE_URL=https://api.groq.com/openai/v1`, and `AI_API_KEY`)*

#### Option 3: OpenRouter Setup (Free Model Access)
1. Obtain an API key at [openrouter.ai](https://openrouter.ai/).
2. In `.env`:
   ```env
   AI_PROVIDER=openrouter
   AI_BASE_URL=https://openrouter.ai/api/v1
   AI_MODEL=meta-llama/llama-3.3-70b-instruct:free
   AI_API_KEY=sk-or-your_openrouter_key
   ```

#### Option 4: Ollama Setup (100% Local & Free, No API Key Needed)
1. Install [Ollama](https://ollama.com/) and run a local model:
   ```bash
   ollama run llama3
   ```
2. In `.env`:
   ```env
   AI_PROVIDER=ollama
   AI_BASE_URL=http://localhost:11434/v1
   AI_MODEL=llama3
   # No AI_API_KEY required
   ```

> **.env is git-ignored.** Never commit real credentials.

---

## Custom Rules Engine

RepoJudge features a declarative, secure custom rules engine (zero `eval`, zero code execution) allowing evaluators to enforce project-specific requirements without changing the core codebase.

### Key Principles
- **Deterministic & Safe**: Evaluated purely against verified file tree snapshots and metadata. No arbitrary code execution.
- **Independent Scoring**: The built-in score remains strictly out of 30. Custom rules are evaluated and reported in a separate "Custom specification checks" section (with PASS/FAIL status and concrete evidence).
- **AI Non-Overridable**: AI models can never override or bypass custom rule results.
- **Multiple Sources**: Custom rules can be placed in `rules.json` at the root of the project, or added and managed dynamically in the browser UI (with `localStorage` persistence, JSON export, and import).

### Supported Check Types

#### 1. `file_exists`
Verifies that a mandatory file exists in the repository.
```json
{
  "id": "custom.has_dockerfile",
  "name": "Dockerfile Exists",
  "check": "file_exists",
  "params": {
    "path": "Dockerfile"
  },
  "severity": "medium",
  "weight": 1
}
```

#### 2. `file_missing`
Ensures forbidden or sensitive files are NOT tracked in git.
```json
{
  "id": "custom.env_missing",
  "name": "No Committed .env Files",
  "description": "Ensures environment files with sensitive keys are not tracked in git",
  "check": "file_missing",
  "params": {
    "path": ".env"
  },
  "severity": "high",
  "weight": 2
}
```

#### 3. `file_contains`
Checks whether a file contains a specific text string or matches a regular expression.
```json
{
  "id": "custom.readme_has_license",
  "name": "README License Mention",
  "description": "Verifies that the README mentions licensing or MIT",
  "check": "file_contains",
  "params": {
    "path": "README.md",
    "pattern": "MIT",
    "isRegex": false
  },
  "severity": "medium",
  "weight": 1
}
```

#### 4. `file_count`
Counts files matching a glob pattern and verifies minimum or maximum thresholds.
```json
{
  "id": "custom.source_ts_count",
  "name": "TypeScript Source Files Count",
  "description": "Verifies that the repository contains at least 1 source file in src/",
  "check": "file_count",
  "params": {
    "glob": "src/**/*.ts",
    "min": 1
  },
  "severity": "medium",
  "weight": 1
}
```

#### 5. `json_field_equals`
Inspects a JSON file (e.g. `package.json`) using dot-notation field traversal and compares against an expected value.
```json
{
  "id": "custom.package_license",
  "name": "Package JSON License",
  "check": "json_field_equals",
  "params": {
    "path": "package.json",
    "field": "license",
    "value": "MIT"
  },
  "severity": "medium",
  "weight": 1
}
```

---

## Run

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot-reload via tsx |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm start` | Run compiled server from `dist/` |
| `npm test` | Run vitest test suite |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20, TypeScript (strict) |
| Web server | Express 5 |
| GitHub API | @octokit/rest |
| AI layer | OpenAI-compatible chat completions (Groq, OpenRouter, Ollama) |
| Custom rules | Declarative Zod schema + deterministic AST-safe engine |
| Schema / validation | Zod |
| Testing | Vitest |

---

## Code of Conduct

This project follows the [MLH Code of Conduct](https://github.com/MLH/mlh-policies/blob/main/code-of-conduct.md). All contributors are expected to uphold it.

---

## License

[MIT](LICENSE)