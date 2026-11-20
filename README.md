# Rifle Season Planner

A season-planning tool for 10m air rifle and 50m rifle 3 positions. It periodises each athlete's year backwards from their peak competitions (preparation phases, tapers, recovery, holidays), builds 4-week loading blocks, and checks the calendar for conflicts.

## How it runs

Plain HTML, CSS and JavaScript with no build step, published as a private Claude artifact:

- `index.html`: the page, its styles and its markup. It is written without `<html>`, `<head>` or `<body>` tags because the artifact host wraps it in that skeleton.
- `js/core.js`: dates, defaults and the planning logic (`plan`, `suggest`, `focus`). No page state.
- `js/feed.js`: the rankings-feed maths (`goalCalc`, `feedScore`, `mainGoal`). Takes the feed as a parameter.
- `js/app.js`: page state, storage, every view, event handlers and start-up.

The three scripts load in that order and share one global scope.

Data lives in the artifact's database:

- `athletes/<id>`: one document per athlete (season, settings, event ticks and priorities, hand adjustments, notes, results, goals, training scores).
- `shared/calendar`: the shared competitions, camps and holidays, with links to ISSF competitions.
- `feed/*`: the rankings-feed copy (see below).

When the database is not available the page falls back to browser storage. The Backup panel downloads all athletes and the calendar as JSON and restores from such a file.

## Tests

```
node tests/run-tests.js
FEED_JSON=/path/to/rifle-feed.json node tests/run-tests.js
```

The first checks the planning logic and the feed formulas on made-up data. The second also checks every athlete in the real feed against the feed's own headline numbers.

## Updating the published page

Edit the files, run the tests, then publish `index.html` with `js/core.js`, `js/feed.js` and `js/app.js` as supporting files to the same artifact from a Claude Code session, so the link stays the same. The artifact declares the `db` (with the `feed` write rule), `user` and `downloads` capabilities.

## Rankings feed

Goals and pathways use the Olympic Rifle Rankings feed (`rifle-feed.json` in the private, read-only repository `MBargeron94/rifle-rankings-feed`). The page never contacts GitHub and holds no token. A copy of the feed lives in the artifact database's `feed` collection:

- `feed/meta`: `generated`, `fetched`, the feed calendar, and `chunks`, the list of event documents the page reads.
- `feed/<EVENT>-<n>`: each event's benchmarks, venues and athletes, split to stay under the 256 KiB document limit.

Only Owners and Editors can write the `feed` collection (artifact access rule `feed: read view, write admin`).

### Refreshing the feed (on request)

In a Claude Code session with read access to `MBargeron94/rifle-rankings-feed`:

1. Clone or pull the feed repository. Never write to it.
2. Run `python3 -I tools/feed_to_docs.py PATH/TO/rifle-feed.json OUT_DIR`.
3. Write every file in `OUT_DIR/feed/` to the artifact's `feed` collection with the ArtifactData tool, as a `set` per document (pin each existing document to the version you last read), in batches under 1 MiB. Write `meta` last, since it names the chunks the page reads.

### Formulas

The page follows the feed README exactly (`goalCalc` in `js/feed.js`). Checked against the feed's own `headline` values for all 951 athlete entries: differences are within the feed's rounding (at most 0.1 point on levels, under one percentage point on chances).

- A goal start date before the feed's `generated` date uses the athlete's current level (`meanNow`).
- The level needed for a medal uses the 3rd-best line (`cut3`) for every event.
