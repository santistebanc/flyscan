# Domain glossary

**Source**: A provider asked for flight offers. A source can require a person to clear a challenge before it will answer again.

**Search**: A person's request for one route, party, cabin, and set of departure/return dates. A search collects scrapes and presents their combined results and progress.

**Scrape**: One source asked about one trip. Several searches can subscribe to the same scrape without repeating its work.

**Attempt**: One execution of a queued task. A scrape can require several attempts after temporary failures or challenge clearance.

**Challenge**: A source's request for human verification. It pauses further work for that source while other sources continue.

**Clearance**: Evidence earned by a person completing a challenge, or confirmation that the source no longer requires verification. Clearance allows waiting work to resume.

**Challenge lifecycle**: Encountering a challenge, waiting for clearance, and resuming the original work. A challenge remains pending when verification fails or is abandoned.

**Search lifecycle**: Starting or joining a search, publishing results and progress, accepting cancellation, and reaching one terminal outcome.

**Subscription**: One caller's interest in a scrape. Cancelling one subscription does not cancel work that another caller still needs.

**Check page tidy**: A per-source method that, in the window where a person clears a challenge, accepts the source's cookie consent and hides everything except the captcha and its Continue button. It only changes what is shown; the person still clears the challenge.
