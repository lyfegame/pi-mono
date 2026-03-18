# Pi Monorepo (Langfuse Fork)

Fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono) with **Langfuse observability** baked into the pi coding agent.

What this fork adds:
- Auto-instrumentation via OpenTelemetry — set `LANGFUSE_SECRET_KEY` and get full trace trees
- Cross-process trace linking for multi-agent orchestration (`TRACEPARENT` propagation)
- Session ID correlation between `.jsonl` session files and Langfuse traces
- Multi-agent example with expert discovery and delegation

## Install as CLI

```bash
# One-command install (clones, builds, symlinks `pi` into ~/.local/bin)
curl -fsSL https://raw.githubusercontent.com/lyfegame/pi-mono/main/scripts/install-cli.sh | bash

# With Langfuse/OTel dependencies
curl -fsSL https://raw.githubusercontent.com/lyfegame/pi-mono/main/scripts/install-cli.sh | WITH_LANGFUSE=1 bash

# Update to latest
bash ~/.pi-source/scripts/install-cli.sh
```

Make sure `~/.local/bin` is in your `PATH`.

## Langfuse Setup

Set these environment variables (e.g. in `.env`):

```bash
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com  # or your self-hosted URL
```

Then just run `pi` as normal — traces appear automatically in Langfuse.

## Multi-Agent Example

See [packages/examples/langfuse-integrated-agent.ts](packages/examples/langfuse-integrated-agent.ts) for a working multi-agent orchestration example with:
- Expert definitions as markdown files in `packages/examples/experts/`
- `find_experts` + `delegate_to_expert` tools for the parent agent
- Per-expert custom system prompts and tool sets
- Full Langfuse trace trees with cross-process linking

```bash
# Build first
npm run build

# Run (requires LANGFUSE_* and OPENAI_API_KEY env vars)
node --experimental-strip-types packages/examples/langfuse-integrated-agent.ts

# Custom prompt
node --experimental-strip-types packages/examples/langfuse-integrated-agent.ts "your prompt here"
```

## Upstream Sync

This fork tracks [badlogic/pi-mono](https://github.com/badlogic/pi-mono) `main`. To sync:

```bash
git remote add upstream https://github.com/badlogic/pi-mono.git  # once
git fetch upstream main
git rebase upstream/main
npm install && npm run build
```

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
```

## Packages

| Package | Description |
|---------|-------------|
| **[@mariozechner/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@mariozechner/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@mariozechner/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@mariozechner/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@mariozechner/pi-web-ui](packages/web-ui)** | Web components for AI chat interfaces |

## License

MIT
