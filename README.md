# AI Usage Monitor

A VS Code extension that shows token usage, model, duration, and cost for every AI request.

## The one design rule

**Nothing is estimated.** A value the provider did not report renders as `Unavailable`, never as `0`, a blank, or a number derived from a tokenizer. This applies all the way through:

- A model with no verified pricing gets **no cost**, not a guess from a similar model.
- A request whose cache reads can't be priced gets **no cost at all**, rather than a partial total that looks complete but is always too low.
- A context gauge is only drawn when the model's real window size is known.
- Summary cost says how many requests it actually covers when some were unpriced, so the figure is never mistaken for total spend.
- CSV exports leave unreported values as **empty cells**, so a spreadsheet `SUM` can't silently count absent data as zero.

The cost figure is meant to be auditable. Hover any cost to see whether it came from the built-in verified table or your own configured rates.

## Recording usage

Four ways in, all converging on the same pricing logic.

### 1. Automatic — installed tools

On startup the extension detects AI tools installed on this machine and tracks them with no setup. Today that means **Claude Code**: it reads the JSONL transcripts Claude Code already writes under `~/.claude/projects/`, so requests appear as you make them.

Run **AI Usage: Show Detected Tools** to see what was found and where it's reading from.

This is read-only and local:

- Nothing is written to, configured, or sent to the monitored tool.
- Only `message.usage` and a few fields around it are read. **Prompt and response text is never read**, so nothing you typed can reach the history or an export — there's a test asserting exactly that.
- Costs are recomputed from the verified pricing table rather than taken from the transcript, so every number in the UI comes from one set of rules.

| Setting | Default | Does |
| --- | --- | --- |
| `sources.enabled` | `true` | Master switch for automatic tracking |
| `sources.disabled` | `[]` | Source ids to skip, e.g. `["claude-code"]` |
| `sources.backfillDays` | `1` | Days of existing history to import on start; `0` means new requests only |

Requests are deduplicated on the provider's own request id, so restarts, settings changes, and resumed sessions never double-count spend.

Adding another tool means writing one `UsageSource` in `src/sources/` — the store, pricing, and views don't change.

### 2. The ingest endpoint

A loopback HTTP endpoint for your own tooling — a LiteLLM callback, a proxy, a test harness.

Enable `aiUsageMonitor.ingest.enabled`, then run **AI Usage: Copy Ingest Endpoint Snippet** for a ready-to-paste `curl` with the current token.

```bash
curl -sS -X POST http://127.0.0.1:7337/usage \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"durationMs": 1234, "response": { ...raw provider response... }}'
```

Post either a raw provider response, or an envelope adding what the response itself doesn't carry:

| Envelope field | Purpose |
| --- | --- |
| `response` | The raw provider response. Omit the envelope to post one directly. |
| `durationMs` | Wall-clock duration you measured. Providers don't report this. |
| `provider` | The real provider, when the call went through a proxy. |

Security posture, since this opens a socket:

- Bound to `127.0.0.1` explicitly — unreachable from off-host, even on an open network.
- Off unless you enable it.
- Per-session bearer token, compared in constant time, so other local processes can't inject records. **The token is regenerated on every restart** — re-copy the snippet after a window reload.
- 256 KB body cap.
- Only usage metadata is read. Prompts and completions are never parsed or stored.

### 3. From another extension

```ts
const api = vscode.extensions.getExtension("local.ai-usage-monitor")?.exports;
api?.record(response, { durationMs: 1234, provider: "anthropic" });
```

`record(payload, meta?)` parses a raw provider response and returns the stored record, or `undefined` if no adapter recognized it. `recordUsage(record)` takes an already-built record; `history()` returns everything held.

### 4. Supported payload shapes

| Adapter | Recognizes |
| --- | --- |
| `anthropic` | Messages API responses (`input_tokens`, `cache_read_input_tokens`, per-TTL `cache_creation` breakdowns) |
| `openai` | Chat Completions and Responses (`prompt_tokens`/`input_tokens`, cached and reasoning token details) |
| `generic` | A flat documented envelope — the fallback when you control the caller |

One normalization worth knowing about, because getting it wrong double-counts the bill: `inputTokens` is always the input billed at the **full** rate, exclusive of cached tokens. Anthropic already reports it that way; OpenAI's `prompt_tokens` is inclusive, so that adapter subtracts. If you post to the `generic` shape, subtract cached tokens yourself.

Adding a provider means writing one `ProviderAdapter` and registering it in `src/adapters/index.ts` — nothing else changes.

## Pricing

The built-in table covers current Anthropic first-party models, each row carrying the date it was reconciled with published pricing.

**Bedrock and Vertex deployments resolve to no built-in price by design.** They're partner-operated and billed separately, so first-party rates would be confidently wrong. Configure your actual rates instead — user pricing always wins, including over the built-in table:

```jsonc
"aiUsageMonitor.pricing.custom": {
  "anthropic.claude-opus-5": { "input": 6, "output": 30 },
  "my-finetune": { "input": 3, "output": 15, "cachedInput": 0.3 }
}
```

Rates are USD per 1M tokens. A rate you omit is treated as unverified, not as zero.

## Commands

| Command | Does |
| --- | --- |
| `AI Usage: Show Usage Panel` | Focus the Requests view |
| `AI Usage: Show Detected Tools` | List installed tools and whether they're tracked |
| `AI Usage: Clear History` | Delete all records (confirms first) |
| `AI Usage: Export History as JSON` / `as CSV` | Write history to a file |
| `AI Usage: Copy Ingest Endpoint Snippet` | Copy a `curl` with the live token |
| `AI Usage: Show Log` | Open the diagnostics channel |

## Running it

```bash
npm install
npm run build
```

Then open this folder in VS Code and press **F5** ("Run Extension"). A second VS Code window opens with the extension loaded — look for the **AI Usage** icon in the activity bar.

The window it opens is a sandbox: the extension is active only there, not in your main editor. Edits rebuild automatically (F5 starts esbuild in watch mode), so after changing code just press **Ctrl+R** in that window to reload.

### Seeing it do something

If Claude Code is installed, the view populates on its own — the last day of requests appears at startup, and new ones show up as you make them. Use Claude Code in any terminal and watch the Requests view.

Nothing showing up? Run **AI Usage: Show Detected Tools**; it reports what was found, or `Not installed`. **AI Usage: Show Log** has the detection diagnostics.

To feed it by hand instead:

1. In the dev window, turn on `aiUsageMonitor.ingest.enabled`.
2. Run **AI Usage: Copy Ingest Endpoint Snippet** (`Ctrl+Shift+P`).
3. Paste it into any terminal and run it.

Worth trying either way: change the `model` to a name that isn't in the pricing table. Cost shows `Unavailable` rather than a plausible guess — the design rule in action.

### Without the debugger

```bash
code --extensionDevelopmentPath="$PWD" .
```

To install it into your real editor, package it with [`vsce`](https://github.com/microsoft/vscode-vsce):

```bash
npx @vscode/vsce package   # produces ai-usage-monitor-0.1.0.vsix
code --install-extension ai-usage-monitor-0.1.0.vsix
```

## Development

```bash
npm run verify   # typecheck, lint, test, build — run this before committing
npm run watch    # esbuild in watch mode (F5 starts this for you)
npm test         # node:test over compiled output
```

The core logic — pricing, cost, adapters, store, formatting — has no `vscode` imports, so the whole suite runs under `node --test` without an extension host. **Debug Tests** in the debugger dropdown steps through it with breakpoints.
