#!/bin/bash
# PreToolUse guardrails for factory workers (FACTORY_WORKER=1). Exit 2 = refuse, stderr tells the agent why.
[[ "$FACTORY_WORKER" == 1 ]] || exit 0
input=$(cat)
tool=$(jq -r '.tool_name' <<<"$input")
refuse() { echo "Blocked by factory guardrail: $1" >&2; exit 2; }

case "$tool" in
  Edit|Write|MultiEdit|NotebookEdit)
    path=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input")
    [[ "$path" == */.github/workflows/* ]] && refuse "the bot can't change CI workflows. Describe the change in the PR and open a ready-for-human issue for it."
    ;;
  Bash)
    cmd=$(jq -r '.tool_input.command' <<<"$input")
    grep -Eq -- '--no-verify' <<<"$cmd" && refuse "commit hooks must run. Fix what they report instead."
    grep -Eq 'git +push +.*(--force|-f( |$)|--force-with-lease)' <<<"$cmd" && refuse "no force-push. Add a new commit instead."
    grep -Eq 'git +push +.*( |:)(main|master)( |$)' <<<"$cmd" && refuse "push only to your ticket branch."
    grep -Eq 'git +(reset +--hard|clean +-[a-zA-Z]*f|branch +-D|checkout +--? +\.|restore +\.)' <<<"$cmd" && refuse "destructive git command. Use git stash or a new commit."
    if [[ "$FACTORY_ALLOW_LIVE" != 1 ]] && grep -Eq '(flight-scraper|flight_scraper(\.cli)?) +(scrape|capture|unblock|places|rates|serve)\b|npm +run +(dev|tauri)|tauri +dev' <<<"$cmd"; then
      refuse "this would contact the live sites (see AGENTS.md). Use tests, fixtures and recordings; the brief must allow a live run."
    fi
    ;;
esac
exit 0
