---
description: "EVAL_* variables reach the mod, the key from EVAL_OPENROUTER_API_KEY and options from EVAL_JEV_CONTEXT_*."
tags: [smoke, config]
max_turns: 2
timeout_seconds: 120
runs: 1
env:
  EVAL_JEV_CONTEXT_GATE: "1"
  EVAL_JEV_CONTEXT_GATE_TOOLS: "Bash,Read"
  EVAL_JEV_CONTEXT_KEEP_THRESHOLD: "0.45"
---

/jev
