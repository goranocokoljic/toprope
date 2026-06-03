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
