"""Split rifle-feed.json into documents for the planner's artifact database.

Usage: python3 -I tools/feed_to_docs.py PATH/TO/rifle-feed.json OUT_DIR

Writes OUT_DIR/feed/<doc_id>.json, one file per database document in the
`feed` collection:

- meta: generated, source, version, fetched, the feed calendar, and the list
  of chunk ids the page should read. The page reads only the chunks listed
  here, so old chunks left behind by an earlier refresh are ignored.
- <EVENT>-<n>: one or more chunks per event. Chunk 0 carries the event's
  label, format, headline target, benchmarks and venues. Every chunk carries
  a slice of the athletes, kept under the size limit for one document.

Athlete scores are rewritten from [date, competition, level, score,
venueAdjustedScore, place] to objects {d, c, l, s, v, p}, because the
database stores objects more reliably than nested arrays. Nothing else in
the feed is changed, so the page's numbers come from the feed's own values.
"""
import json
import os
import sys
from datetime import datetime, timezone

LIMIT = 180_000  # bytes per document; the database allows 256 KiB


def size(obj):
    return len(json.dumps(obj, separators=(",", ":")).encode("utf-8"))


def athlete_doc(a):
    out = dict(a)
    out["scores"] = [
        {"d": s[0], "c": s[1], "l": s[2], "s": s[3], "v": s[4], "p": s[5]}
        for s in a.get("scores", [])
    ]
    return out


def main(src, out_dir):
    with open(src, encoding="utf-8") as fh:
        feed = json.load(fh)
    target = os.path.join(out_dir, "feed")
    os.makedirs(target, exist_ok=True)
    chunks = []
    for key, ev in feed["events"].items():
        head = {k: ev[k] for k in ("label", "format", "headlineTarget", "benchmarks", "venues")}
        athletes = [athlete_doc(a) for a in ev["athletes"]]
        n, cur = 0, {"event": key, "head": head, "athletes": []}
        for a in athletes:
            if cur["athletes"] and size(cur) + size(a) > LIMIT:
                chunks.append((f"{key}-{n}", cur))
                n += 1
                cur = {"event": key, "athletes": []}
            cur["athletes"].append(a)
        chunks.append((f"{key}-{n}", cur))
    for doc_id, doc in chunks:
        if size(doc) > 250_000:
            raise SystemExit(f"{doc_id} is too large for one document")
        with open(os.path.join(target, doc_id + ".json"), "w", encoding="utf-8") as fh:
            json.dump(doc, fh, separators=(",", ":"))
    meta = {
        "generated": feed["generated"],
        "source": feed.get("source"),
        "version": feed.get("version"),
        "fetched": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "calendar": feed["calendar"],
        "chunks": [doc_id for doc_id, _ in chunks],
    }
    with open(os.path.join(target, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, separators=(",", ":"))
    for doc_id, doc in chunks:
        print(doc_id, size(doc), "bytes,", len(doc["athletes"]), "athletes")
    print("meta", size(meta), "bytes")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
