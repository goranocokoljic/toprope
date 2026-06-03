# Summary Model — Default & Infrastructure Requirements

GovProxy's AI-generated summaries (weekly / monthly / quarterly / yearly) are
produced by a configurable text-generation model. The model is configured under
`summaries.model` in `govproxy.config.yaml`, with optional per-level overrides.

## Why local by default

Summaries default to a **local model served by [Ollama](https://ollama.com/)**.
This is a privacy decision, not a cost one:

- The model only ever receives the **numbers-only payload** built by
  `src/summaries/input-builder.ts` — aggregate metrics, deltas, and benchmark
  numbers. It never receives code, commit messages, or any free text from
  repositories.
- Keeping the default endpoint local (`http://localhost:11434`) guarantees that
  even that aggregate data never leaves the network.

Cloud providers (`anthropic`, `openai`) are supported for teams that prefer them,
but local is the recommended and documented default.

## Default model

The summaries are executive-facing output where narrative quality matters most,
so the **default base model is a larger local model**, with the high-frequency
weekly level overridden to a smaller, faster model:

| Level                  | Default model   | Rationale                                  |
|------------------------|-----------------|--------------------------------------------|
| `model` (base)         | `llama3.1:70b`  | Quality for monthly/quarterly/yearly       |
| `weekly` (override)    | `llama3.1:8b`   | Fast turnaround for short, frequent output |
| `monthly`/`quarterly`/`yearly` | inherit base (`llama3.1:70b`) | Higher-quality long-form narrative |

> **Confirm against your dogfood infra.** The `70b` default assumes a host that
> can serve it acceptably (see below). If your infra can't, set
> `summaries.model.model_name` to a smaller model (e.g. `llama3.1:8b`) — the
> per-level override mechanism means you can also mix sizes.

## Infrastructure requirements

Approximate requirements for serving via Ollama (4-bit quantized weights, the
Ollama default):

| Model          | Disk    | Memory (VRAM or unified/CPU RAM)        | Notes                                   |
|----------------|---------|------------------------------------------|-----------------------------------------|
| `llama3.1:8b`  | ~5 GB   | ~6–8 GB                                  | Runs on a single consumer GPU or modern laptop |
| `llama3.1:70b` | ~40 GB  | ~48 GB+ (e.g. 1× A100 80GB, 2× 24GB GPUs, or 64GB+ Apple Silicon) | GPU strongly recommended; CPU-only is slow |

To install and serve a model:

```bash
ollama serve            # start the local server (listens on :11434)
ollama pull llama3.1:70b
ollama pull llama3.1:8b
```

`govproxy doctor` checks that the configured Ollama endpoint is reachable when
summaries are enabled.

## Graceful failure

If the model endpoint is unreachable (Ollama not running, network error,
timeout) or returns an error, summary generation **does not crash** the
scheduler. The model client (`src/summaries/model-client.ts`) returns a failure
result, the event is logged, and the summary is left not-generated and
retryable on the next run.

## Switching to a cloud model

To use Anthropic or OpenAI instead, set the type, model, and key:

```yaml
summaries:
  model:
    type: "anthropic"        # or "openai"
    model_name: "claude-haiku-4-5-20251001"
    api_key: "${SUMMARY_MODEL_API_KEY}"
```

Note this sends the aggregate (numbers-only) payload to that provider. For
`openai` and openai-compatible servers, set `endpoint` to the base URL.

> **OpenAI parameter note.** The `openai` branch sends the legacy `max_tokens`
> field, which OpenAI-compatible servers (vLLM, LM Studio, Ollama's OpenAI shim)
> and older OpenAI models accept. Newer first-party OpenAI reasoning models
> require `max_completion_tokens` and will reject `max_tokens` with an HTTP 400 —
> handled gracefully (the summary is skipped, not crashed), but it means those
> specific models won't generate via this branch. The branch primarily targets
> local/compatible servers.

## Tier-aware prompts and the fabricated-usage guard

The narrative is produced from the **tier-aware prompt templates** in
`src/summaries/prompts.ts` (`buildSummaryPrompt`). There is one template per level
(weekly / monthly / quarterly / yearly), each sharing a common preamble that, for a
git-only period (`ai_maturity_basis = git_estimate`):

- states the `data_basis` (e.g. *"git analysis + expense data; no direct tool
  usage"*) and tells the model to carry it into the prose;
- forbids the direct-tool-usage vocabulary ("acceptance rate," "interactions,"
  "suggestions accepted," …) that the git-derived data does not contain;
- requires review/insight framing, aggregate-first, with neutral factual
  individual mentions only;
- states deltas only when present (first periods say *"no prior comparison"*).

Only a fully `measured` period (all metrics backed by direct tool data) relaxes the
ban. A `mixed` period — *partial* direct usage — keeps the ban, because the
numbers-only payload carries no per-tool usage figure to substantiate those terms
for any given number; lumping `mixed` in with `measured` would silently switch the
guard off while fabrication is still possible.

The prompt is a *soft* instruction. The *hard* enforcement is the output guard,
`assertNoFabricatedUsageLanguage(text, payload)` / `findFabricatedUsageLanguage`,
which scans generated text for the forbidden vocabulary and rejects a non-measured
summary that contains any of it. It is a fixed-phrase **tripwire, not a guarantee**:
it fails open against paraphrases the catalog doesn't list (the prompt is the real
control), so the generator (Task 3.9) must treat a clean result as "no *known*
forbidden phrase," not "verified compliant." The summary generator runs this guard
on model output before persisting.

### Manual spot-check against the real local model

The automated tests drive the prompt → model → guard path with a *mocked* model so
assertions are deterministic. Because a mock can't reveal whether a *real* model
honours the tier constraints, do a manual spot-check after changing the prompts or
the default model. Until the `summary generate`/`show` CLI lands in Task 3.9, render
a prompt and POST it to the local model directly:

```bash
ollama serve                 # ensure the local endpoint is up
# Render a prompt with buildSummaryPrompt(payload) for a git-only scope, then:
curl http://localhost:11434/api/generate \
  -d '{"model":"llama3.1:8b","prompt":"<rendered prompt>","stream":false}'
```

> Once Task 3.9 ships, the same spot-check is one command:
> ```bash
> npx govproxy summary generate --level weekly --period 2026-W21 --scope team:backend
> npx govproxy summary show     --level weekly --period 2026-W21 --scope team:backend
> ```

Read the output and confirm by eye that it:

- contains **none** of: "acceptance rate," "interactions," "suggestions accepted,"
  or any other direct-tool-usage phrasing;
- states the git-based data basis at least once;
- describes git signals as such ("commit activity," "merged PRs," "code churn,"
  "estimated AI-assistance signal");
- names no individual evaluatively (neutral factual mentions only);
- reads in the concise, analytical, review-oriented default voice;
- for a first period, says "no prior comparison" rather than inventing a delta.

If the real model drifts into forbidden language despite the prompt, the guard will
reject it at generation time — but tighten the preamble wording rather than relying
on the guard alone.
