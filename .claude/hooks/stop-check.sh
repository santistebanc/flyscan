#!/bin/bash
# Stop hook for factory workers: refuse to finish while checks are red or tests were deleted.
# Blocks at most 3 times per worktree, then lets the agent stop (it should post a handoff).
[[ "$FACTORY_WORKER" == 1 ]] || exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0
counter="$(git rev-parse --git-dir)/factory-stop-blocks"
base=$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD)
problems=()

deleted=$( { git diff --name-only --diff-filter=D "$base"; git diff --name-only --diff-filter=D --cached "$base"; } | sort -u | grep -E '^(tests/|desktop/tests/)' )
[[ -n "$deleted" ]] && problems+=("Test files deleted: $(tr '\n' ' ' <<<"$deleted")(restore them, or ask the owner with factory-ask)")

uv run --quiet ruff check --quiet . >/dev/null 2>&1 || problems+=("ruff check fails (run: uv run ruff check .)")
uv run --quiet pytest -q -x >/tmp/factory-pytest.$$ 2>&1 || problems+=("pytest fails: $(tail -3 /tmp/factory-pytest.$$ | tr '\n' ' ')")
rm -f /tmp/factory-pytest.$$
if git diff --name-only "$base" | grep -q '^desktop/'; then
  (cd desktop && npm test --silent >/dev/null 2>&1) || problems+=("desktop tests fail (cd desktop && npm test)")
  (cd desktop && npx --no-install tsc --noEmit >/dev/null 2>&1) || problems+=("desktop typecheck fails (cd desktop && npx tsc --noEmit)")
fi

if (( ${#problems[@]} == 0 )); then rm -f "$counter"; exit 0; fi
n=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$counter"
if (( n > 3 )); then
  echo "Checks still red after 3 attempts. Post a handoff comment (factory conventions) before stopping." >&2
  exit 0
fi
printf 'Not done yet (attempt %d/3):\n' "$n" >&2; printf -- '- %s\n' "${problems[@]}" >&2
exit 2
