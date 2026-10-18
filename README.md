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

#### Option 2: Groq Setup (Ultra-Fast Free Tier)
1. Sign up for a free key at [console.groq.com](https://console.groq.com/).
2. In `.env`:
   ```env
   AI_PROVIDER=groq
   AI_BASE_URL=https://api.groq.com/openai/v1
   AI_MODEL=llama-3.3-70b-versatile
   AI_API_KEY=gsk_your_groq_api_key
   ```

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
| Schema / validation | Zod |
| Testing | Vitest |

---

## Code of Conduct

This project follows the [MLH Code of Conduct](https://github.com/MLH/mlh-policies/blob/main/code-of-conduct.md). All contributors are expected to uphold it.

---

## License

[MIT](LICENSE)