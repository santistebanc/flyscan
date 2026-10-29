# Preview

One copy of the app on the Beelink, deployed only when asked. It is for trying a
change in a real setting, from any device on the tailnet, including a phone.

```bash
preview/preview.sh               # deploy main
preview/preview.sh my-branch     # deploy a branch or commit (pushed first)
preview/preview.sh --fresh       # deploy with an empty database
preview/preview.sh status
preview/preview.sh stop          # app, virtual screen and stream all stop
```

It prints the address, `http://beelink-home:8800`. The preview never updates
on its own: pushing to `main` changes nothing until you ask for a preview.

**Checks from a phone.** A check opens in a real Chromium on a phone-shaped
virtual screen (Xvfb), which noVNC streams on `http://beelink-home:6080`.
The browser opens the check as soon as a source asks, so it is loaded by the
time you look: starting it on the busy Beelink takes 15–25 seconds. Verify (or
Open stream, once it is open) shows the stream in a new tab; solve it there and
the search carries on. The cookies land in the preview's own browser profile.

**Its data** lives in `~/.local/share/flight-scraper-preview/data` and survives
redeploys, so each preview runs the new code, migrations included, against what
the last one gathered. `--fresh` moves it to `data.previous` first.

**How a deploy works.** `deploy.sh` runs on the Beelink, always the copy on
`origin/main`. It exports the commit to its own folder, installs it with uv and
Playwright, builds the frontend, and only then points the user services at it,
so a failed build leaves the running preview alone. The last three builds are
kept. Everything binds to the Beelink's Tailscale address; nothing is reachable
from the internet.

The preview sends real requests to the flight sites from the home IP, the same
one an installed app at home uses. It runs no background schedule: only the
searches you start.
