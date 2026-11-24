# Rifle Season Planner: handoff

A season-planning web app for an elite rifle coach (Swiss national team level: World Cups, Europeans, Worlds). Disciplines: 10m air rifle and 50m rifle 3 positions (prone is shown from the rankings feed but not planned). It periodises each athlete's year backwards from their peak competitions, builds 4-week loading blocks, and checks the calendar for conflicts. The coach is the only user for now.

- Live page (private Claude artifact): https://claude.ai/artifact/FZUTckWZyRBJYhpZTNqKHa
- Code: this repository (`MBargeron94/periodisation-app`), branch `main`.
- Rankings data: `MBargeron94/rifle-rankings-feed` (private, read-only for this app; never write to it). Read its `README.md` before touching feed logic.

## Working with this coach

- Plans before building when a change is large; for small changes, just do it and report.
- Wants plain explanations of what changed and what it means for their athletes, and honest notes about what was not tested.
- Decisions are theirs: propose, recommend one option, and ask where it matters. Park features rather than delete them unless told to cut.
- Uses abbreviations in event names (EM = European Championships, WM = World Championships, WC = World Cup, WCF = World Cup Final, SM = Swiss Championships, ShMa = national league match). Names are never parsed by the planner, except the city for ISSF linking.

## Files

- `index.html`: title, styles (theme tokens for light and dark), markup, then `<script src>` for the three files below, in this order. No `<html>/<head>/<body>`; the artifact host wraps the page.
- `js/core.js`: dates, defaults, `plan()` (the whole periodisation engine), `suggest()`, `focus()` (coaching text per week). No page state; `suggest` takes the calendar as a default parameter.
- `js/feed.js`: rankings-feed maths: `assembleFeed`, `feedEntries`, `goalCalc` (README formulas), `feedScore`, `mainGoal`, pathway helpers. Functions take the feed as a parameter (default `st.feed`).
- `js/app.js`: page state `st`, storage (artifact database with browser-storage fallback), all views and their HTML, event handlers, `boot()`.
- `tests/run-tests.js`: `node tests/run-tests.js`; add `FEED_JSON=/path/to/rifle-feed.json` to also check every athlete in the real feed against its own headline numbers. Run before every publish.
- `tools/feed_to_docs.py`: splits `rifle-feed.json` into database documents for a feed refresh.

## Data (artifact database)

- `athletes/<id>`: one document per athlete. Main fields: `name`, `issfId`, `birthYear`, `strength`, `seasonStart`, `weeks`, `hoursMax`, `seasons`, `settings` (taper, recovery, splits, finals shares, shot rates), `picks` (per calendar event: `on`, own `tier`, `taper`), `adj` (hand adjustments by week start date), `weekNotes`, `wlog` (weekly logs), `logIgnore`, `results`, `fgoals` (goals per season), `fgMain`, `training` (training scores), `notes`, `sessions` (week planner: by week start date, a list of `{id, day 0–6 from Monday, ampm, type t10|t50|phys|mental|rec, dur hours, shots (10m), k/p/s (50m), fin, loc, note}`).
- `shared/calendar`: `{events: [...]}`, shared by all athletes. Event types: `comp` (tier `small` = minor, `major`, `key`, `peak`; `training: true` for training matches; `feedComp` = linked ISSF competition id), `camp`, `hol`.
- `feed/meta` and `feed/<EVENT>-<n>`: the rankings-feed copy. Only Owners and Editors can write `feed` (access rule).

Write to these with the ArtifactData tool, always pinned with `if_version` to the version you read. Take a fresh read first: the coach edits the page between sessions.

## Publishing

Publish `index.html` with `files` = `js/core.js`, `js/feed.js`, `js/app.js` (and `root` = this repository) to the artifact URL above, so the link stays the same. Capabilities to keep: `db` with rule `{path: "feed", read: "view", write: "admin"}`, `user`, `downloads`, `sample`. Restate all of them whenever you pass `capabilities`, or omit the field to keep them. Commit and push to `main` after each publish.

## Feed refresh (on request only)

1. Clone `MBargeron94/rifle-rankings-feed` (read access) and read its README.
2. `python3 -I tools/feed_to_docs.py PATH/rifle-feed.json OUT_DIR`
3. Write each file in `OUT_DIR/feed/` to the `feed` collection with ArtifactData `set`, in batches under 1 MiB, pinned to the versions you read. Write `meta` last (it lists the chunks the page reads).
4. Run the tests with `FEED_JSON` set.

No token is used anywhere: the session's GitHub access reads the repo, and the page never contacts GitHub.

## How the plan works (short)

- Peaks (or peaks within 4 weeks of each other) each get a cycle: Preparation 1, Preparation 2, taper (default 2 weeks), competition, recovery.
- Preparation phases are counted on training weeks only.
- Key events get 3 weeks of specific preparation, a 1-week taper and an easy week after, without starting a new cycle. A key event too close to a peak's taper, a recovery or another key event gets a short taper inside the build instead (the old "quota" treatment), shown as a note.
- Majors get a mini-taper. Minors are trained through.
- Holiday weeks (5+ days) are their own phase with no training.
- Week planner ("Plan sessions" on a week card): individual sessions per day, AM/PM, with a planned-against-target table. "Draft this week" (`draftWeek` in core.js) builds sessions that add up to the week's hours, shots and finals; the coach edits from there. Sessions never change the week's targets. Copy from another week and clear are there too.
- No training is planned on competition days.
- Weekly logs adjust the following week (see README "Weekly log"). Hand adjustments win over everything.
- Goals use the feed README formulas exactly. A start date before the feed date uses the current level. The level needed for a medal uses the 3rd-best line for every event.

## Decisions already made

- Route A for the rankings feed: Claude copies the feed into the database on request; no standalone server, no token.
- Quota tick removed; Key covers it.
- Old season-goal feature (estimated final entries, block goals) removed; the feed-based goals replace it.
- Training-camp day plans tried and removed (coach did not like them).
- Junior results: skipped. The feed is senior-only; Martina has no feed entry.
- Not wanted for now: athlete handout, shots-per-position detail beyond what exists, travel/time zones, plan-vs-actual logging beyond the weekly log.
- A standalone web app (own hosting and logins) is deferred until someone other than the coach needs access.

## Open items and ideas

- Week planner: drafting rules are simple (one rest day in a full week, range in the mornings, physical and recovery in the afternoons, a short range session the day before a competition). The coach has not used it yet; expect changes to the draft after first use. Planned sessions are not sent to the Claude block review.

- The live Claude block review and the backup download have only been tested with stand-ins; check the first real use.
- Week labels are not renamed when a log rule caps a week (a "Peak load" week capped to 70% still says "Peak load").
- Possible next steps the coach has seen: position emphasis by phase, fixed test and equipment checkpoints, per-athlete shot rates and age-group rules, squad load view, camp-fit check, undo.
