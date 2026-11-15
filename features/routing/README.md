# Routing — content-aware model selection

Fills the **verified-empty** hook in QwenPaw's own routing layer.

## The seam

`agentscope-ai/QwenPaw@v2.3.0:src/qwenpaw/agents/routing_chat_model.py`
defines `RoutingPolicy.decide(text, channel, tools_available)` and its body is:

```python
del text, channel, tools_available          # content is ignored
if getattr(self.cfg, "mode", "local_first") == "cloud_first":
    return RoutingDecision(route="cloud", reasons=["mode:cloud_first"])
return RoutingDecision(route="local", reasons=["mode:local_first"])
```

Routing is a static switch. This module supplies the missing policy.

## Why lexical, not embeddings

The obvious upgrade is `aurelio-labs/semantic-router` (MIT, 4k★, verified
2026-11-15). It is genuinely better at paraphrase. It is **not usable here**:
its local backend is a resident ONNX encoder, and this box is 4 vCPU / 8 GiB
already running QwenPaw + Chromium + two Xvfb displays. A resident embedding
model is a local model, which the constraints forbid.

So this router is **lexical** — term weights, regex patterns, length gates —
and it says so. It is a *prefilter*, not a reasoner: it chooses between a
cheap model and an expensive one, nothing finer.

**The interface is designed to be swapped.** A semantic router can replace
`Router.classify()` behind the same `Decision` contract without touching a
call site.

## The design property that matters: abstention

`classify()` returns `route=None` when it is unsure, and `decide_with_default()`
is the drop-in for QwenPaw (which must always return a route). The separation
is deliberate:

- "the router has no opinion" and "the router picked the fallback" are
  **different states**, and collapsing them hides a bad route table behind
  plausible output.
- A wrong route costs real money (an expensive model on a trivial prompt) or
  real quality (a cheap model on a hard one). Abstaining costs nothing,
  because the caller keeps its configured default — today's behaviour.

Three abstention rules, each tested:

| Rule | Why |
|---|---|
| `confidence < threshold` (default 0.5) | below this a binary decision is worse than a coin flip |
| `margin < 0.12` when a runner-up exists | two routes with near-equal evidence is not a decision |
| only negative evidence matched | a route that "won" on a penalty is not a match |

## Route names are roles, not models

`cheap` / `tools` / `code` / `deep` are **roles**. Map them to real models in
the QwenPaw config (today: `cheap` = `mosicn/nex-n2.6`, `deep` = Astra). A
model swap then does not require touching `routes.yaml`.

```yaml
default_route: cheap
threshold: 0.5
margin: 0.12
routes:
  - name: cheap
    weight: 1.0
    terms: [summarise, summary, list, rename, format, ticket, status]
  - name: tools
    weight: 1.2
    requires_tools: true
    tools_bonus: 1.0
    tools_penalty: 1.5
    terms: [click, screenshot, desktop, browser, navigate, open, type]
```

## Three bugs the selftest caught (all in this file, all fixed)

Worth recording because each would have shipped silently:

1. **Softmax including zero-scoring routes.** `exp(0)` gives every unmatched
   route a share of the probability mass, which pinned the margin at 0.00 —
   so *every* unambiguous prompt abstained on the margin rule. A route with
   no evidence must get probability 0.
2. **Softmax over a single candidate is always 1.0.** "confidence 1.00" meant
   "only one route matched", not "I am certain". Confidence is now derived
   from the winning score (`1 - exp(-score)`), and the margin rule only
   applies when a runner-up exists.
3. **An unconditional `tools` bonus.** A prompt matching *no* term still scored
   +1.0 on the tools route and won by default — `"zzzz qqqq"` routed to the
   desktop. The bonus is now gated on having matched this route's vocabulary.

## Usage

```bash
python3 features/routing/policy.py --text "click the save button"
# route=tools confidence=0.8892 abstained=False reasons=['term:clickx1', 'tools:available']

python3 features/routing/policy.py --text "hello"
# route=None confidence=0.0 abstained=True reasons=['no-route-matched']

python3 features/routing/policy.py --selftest      # 27 checks
```

From Python:

```python
from policy import Router
router = Router.from_file()           # routes.yaml beside this file
d = router.classify(text, tools_available=True)
if not d.abstained:
    model = ROLES[d.route]            # your mapping
```

## Wiring it into QwenPaw (Muse)

1. Copy `policy.py` + `routes.yaml` into the container at
   `/app/working/routing/`.
2. Patch `RoutingPolicy.decide()` to call `Router.from_file().decide_with_default(...)`
   and map the route name to a model slot.
3. **Ship it disabled.** QwenPaw's config has `enabled`; leave it off, log the
   `reasons` to the existing `audit.db`, and compare the router's suggestion
   against what actually happened for a week before trusting it.

That last step is the honest one: a router that changes behaviour on day one
is an unmeasured change. The reasons field exists so the decision is auditable
after the fact.

## Deliberately not done

- **No embedding model** (see above).
- **No LLM-as-router.** That costs a model call to save a model call.
- **No training.** `RouteLLM` trains on preference data and its last commit is
  2024-08; `semantic-router`'s `fit()` needs labelled examples we do not have.
  A hand-written table that abstains is more honest than an unfitted model.
- **No auto-tuning of thresholds.** Calibrating against real traffic needs
  real traffic; the `reasons` log is the input for that later.
