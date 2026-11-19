# Claude account connection

Settings now offers **Claude account** beside the existing connections: Claude API key, Gemini, OpenAI API key, ChatGPT account and Codex account. Nothing about the other connections changed.

| Connection | Login | Credential storage |
| --- | --- | --- |
| Claude account | Official Claude Code client, browser sign-in with a Claude subscription | The client's own store, isolated in this app's `claude-profile` folder |
| Claude API key | Existing API-key flow | Existing encrypted `credentials.enc` |

## Requirements and sign-in

Install Claude Code once from claude.com/claude-code. The app finds `claude` in `~/.local/bin`, `~/.claude/local`, Homebrew, `/usr/local/bin` or `PATH`. If it is missing, Settings says so and the sign-in button stays disabled.

Choose **Claude account** in Settings, then **Sign in with Claude**. The official client opens your browser and completes the login itself. The app then reads the signed-in email and plan from `claude auth status`. **Sign out** runs `claude auth logout` for this app's profile and confirms it.

## How it works

Each question starts the official client once in print mode and streams its answer. It is invoked with every tool, MCP server, skill, settings source and saved session turned off, so it can only answer the supplied text and images. Earlier turns in the bounded conversation are sent as quoted context, and each image is sent as a base64 image block, in order.

- **Separate login.** The client runs with `CLAUDE_CONFIG_DIR` pointing at this app's profile. It does not use, change or sign out your terminal Claude Code login, and signing out here leaves the terminal alone.
- **No credentials in the app.** The app never reads, stores or shows a token. The renderer sees only the email and plan.
- **Clean environment.** The client receives an allowlisted environment. `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, OAuth tokens and `CLAUDE_CODE_*` settings from the launching shell are never passed on.
- **Fast sign-in failures.** If the session is rejected the client retries many times by itself; the app stops at the first 401/403 and asks you to sign in again.
- **Stable errors.** Errors are mapped to fixed messages (signed out, usage limit, request failed, timed out). Provider text is never echoed or logged.
- **Stop** ends the client process. A request has a ten-minute limit.

## Models and limits

The picker offers Claude Sonnet 5.5, Opus 5.5, Haiku 5.5 and Fable 5.1, with each model's reasoning-effort choices. Which of these your plan can use, and how much, depends on your Claude subscription. Subscription usage limits apply and are shown as a usage-limit message when reached. Using the subscription this way is subject to Anthropic's terms for Claude Code; check that your plan and use are covered.

## Verification

`tests/claude-account.test.js` covers the environment allowlist, locked-down arguments, streaming, fallback and multi-block output, 401 handling, error mapping, Stop, one-at-a-time answers, sign-in, cancel, timeout and sign-out. `tests/claude-desktop.js` drives the real window and IPC bridge with a fake client. A real `claude` binary was also run with the exact arguments in a signed-out profile and failed fast with the sign-in message. A signed-in end-to-end answer needs your own Claude login and has not been run.
