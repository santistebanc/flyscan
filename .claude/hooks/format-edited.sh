#!/bin/bash
# PostToolUse (Edit/Write): format and autofix the Python file that was just edited.
f=$(jq -r '.tool_input.file_path // empty')
[[ "$f" == *.py && -f "$f" ]] || exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0
uv run --quiet ruff check --fix --quiet "$f" >/dev/null 2>&1
uv run --quiet ruff format --quiet "$f" >/dev/null 2>&1
exit 0
