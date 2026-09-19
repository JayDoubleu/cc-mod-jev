#!/usr/bin/env bash
# Live check of the tool.call gate: runs one headless session with the gate on,
# lets the model run `seq 1 4000`, and checks the stream for the cut note.
# Needs OPENROUTER_API_KEY and a Claude Code login. Costs one short session.
set -euo pipefail
plugin="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 JEV_CONTEXT_GATE=1 claude -p \
  'Run the shell command `seq 1 4000` with the Bash tool exactly once, without piping. Then reply with one line only: "last number: N".' \
  --plugin-dir "$plugin" --allowedTools Bash --permission-mode dontAsk \
  --output-format stream-json --verbose < /dev/null 2>/dev/null > stream.jsonl
python3 - stream.jsonl <<'PY'
import json, sys
seen = False
for line in open(sys.argv[1]):
    try:
        d = json.loads(line)
    except ValueError:
        continue
    content = (d.get('message') or {}).get('content')
    if not isinstance(content, list):
        continue
    for block in content:
        if isinstance(block, dict) and block.get('type') == 'tool_result':
            body = block.get('content')
            text = body if isinstance(body, str) else json.dumps(body)
            cut = '[jev-context cut' in text
            seen = True
            print(f"tool_result: {len(text)} chars, cut note {'present' if cut else 'ABSENT'}")
            if not cut:
                sys.exit(1)
if not seen:
    print('no tool_result in the stream')
    sys.exit(1)
print('gate-smoke: ok')
PY
