# Rifle Season Planner

A season-planning tool for 10m air rifle and 50m rifle 3 positions. It periodises each athlete's year backwards from their peak competitions (preparation phases, tapers, recovery, holidays), builds 4-week loading blocks, and checks the calendar for conflicts.

## How it runs

- `index.html` is the whole app: plain HTML, CSS and JavaScript, no build step.
- It is published as a private Claude artifact. The page content is written without `<html>`, `<head>` or `<body>` tags because the artifact host wraps it in that skeleton.
- Data lives in the artifact's database:
  - `athletes/<id>`: one document per athlete (season, settings, event ticks and priorities, hand adjustments, notes, results).
  - `shared/calendar`: the shared competitions, camps and holidays.
- When the database is not available the page falls back to browser storage.

## Updating the published page

Edit `index.html`, then publish it to the same artifact from a Claude Code session so the link stays the same.
