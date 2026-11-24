/* Tests for the planning logic (js/core.js) and the rankings-feed maths (js/feed.js).

   Run:   node tests/run-tests.js
   With the real feed as an extra check:
          FEED_JSON=/path/to/rifle-feed.json node tests/run-tests.js

   The page scripts are loaded into one sandbox, the way the browser loads them,
   so the tests call exactly the code the page runs. Nothing here needs a browser. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ctx = vm.createContext({ console, Math, Date, JSON, Intl });
for (const f of ["core.js", "feed.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", f), "utf8"), ctx, { filename: f });
}
const run = code => vm.runInContext(code, ctx);
const plan = run("plan"),
  goalCalc = run("goalCalc"),
  assembleFeed = run("assembleFeed"),
  feedScore = run("feedScore"),
  parse = run("parse");

let failed = 0,
  passed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else {
    failed++;
    console.log("FAIL", name, detail === undefined ? "" : detail);
  }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---------- planning ---------- */
const comp = (id, name, disc, tier, start, end) => ({ id, name, type: "comp", disc, tier, start, end: end || start });
const athlete = {
  name: "Test athlete",
  seasonStart: "2026-11-02",
  weeks: 52,
  hoursMax: 30,
  settings: {},
  events: [
    comp("p1", "Euros 10m", "10m", "peak", "2027-03-06", "2027-03-12"),
    comp("p2", "Worlds", "both", "peak", "2027-09-27", "2027-10-05"),
    comp("k1", "Key World Cup", "50m", "key", "2027-06-09", "2027-06-12"),
    comp("m1", "Club match", "10m", "small", "2027-02-06", "2027-02-06"),
    { id: "h1", name: "Christmas", type: "hol", disc: "both", tier: null, start: "2026-12-21", end: "2027-01-03" },
  ],
};
const P = plan(athlete);
const wk = d => P.W[Math.floor((parse(d) - P.s0) / (7 * 864e5))];

check("season has 52 weeks", P.W.length === 52, P.W.length);
check("peak week is a competition week", wk("2027-03-08").phase === "COMP", wk("2027-03-08").phase);
check("week after the first peak is recovery", wk("2027-03-15").phase === "REC", wk("2027-03-15").phase);
check("full holiday weeks are holiday phase", wk("2026-12-21").phase === "HOL" && wk("2026-12-28").phase === "HOL",
  [wk("2026-12-21").phase, wk("2026-12-28").phase]);
check("holiday weeks have no training", wk("2026-12-21").load === 0 && wk("2026-12-21").hours === 0, wk("2026-12-21").load);
check("week before a key event is its taper", wk("2027-06-01").type === "Key taper", wk("2027-06-01").type);
check("key event week is a key competition", wk("2027-06-08").type === "Key competition", wk("2027-06-08").type);
check("week after a key event is an easy week", wk("2027-06-15").type === "Easy week", wk("2027-06-15").type);
check("key event does not start a new cycle", P.clusters.length === 2, P.clusters.length);
check("a week that is all competition has no training", wk("2027-09-27").load === 0, wk("2027-09-27").load);
check("competition days reduce a partly-competition week", wk("2027-06-08").load < 50, wk("2027-06-08").load);
check("no week goes over full volume", P.W.every(w => w.load <= 110), Math.max(...P.W.map(w => w.load)));
check("every week belongs to a 4-week block", P.W.every(w => w.block != null));
check("weekly hours follow volume", P.W.every(w => Math.abs(w.hours - (30 * w.load) / 100) <= 0.25));

const P2 = plan(Object.assign({}, athlete, { events: athlete.events.concat([comp("k2", "Late key", "10m", "key", "2027-02-17", "2027-02-20")]) }));
const wk2 = d => P2.W[Math.floor((parse(d) - P2.s0) / (7 * 864e5))];
check("a key event too close to a peak gets a note, not a conflict",
  P2.flags.some(f => f.lv === "info" && /Late key is a key event, but/.test(f.t)) && !P2.flags.some(f => f.lv === "warn" && /Late key/.test(f.t)));
check("a key event too close to a peak does not reshape the phases", P2.W.filter(w => w.keyEv && w.keyEv.id === "k2").length === 0);

/* ---------- weekly log rules ---------- */
const withLog = (wlog, extra) => plan(Object.assign({}, athlete, { wlog }, extra || {}));
const base = plan(athlete);
const at = (Q, d) => Q.W[Math.floor((parse(d) - Q.s0) / (7 * 864e5))];
check("test weeks are build weeks", ["2027-01-11", "2027-01-18", "2027-01-25", "2027-02-01"].every(d => /PP/.test(at(base, d).phase)),
  ["2027-01-11", "2027-01-18", "2027-01-25", "2027-02-01"].map(d => at(base, d).phase));
let Q = withLog({ "2027-01-11": { health: "ill" } });
check("ill: next week capped at 50% with no finals", at(Q, "2027-01-18").load <= 50 && at(Q, "2027-01-18").inten <= 4 && at(Q, "2027-01-18").split.fin === 0,
  [at(Q, "2027-01-18").load, at(Q, "2027-01-18").inten, at(Q, "2027-01-18").split.fin]);
check("ill: the adjustment is listed on next week's card", at(Q, "2027-01-18").logAdj.some(x => x.rule === "ill"));
Q = withLog({ "2027-01-11": { health: "ill" } }, { logIgnore: { "2027-01-18|ill": 1 } });
check("an ignored adjustment is not applied", at(Q, "2027-01-18").load === at(base, "2027-01-18").load && at(Q, "2027-01-18").logAdj[0].ign);
Q = withLog({ "2027-01-11": { fatigue: "tired" }, "2027-01-18": { fatigue: "very" } });
check("tired two weeks running: next week is a deload", at(Q, "2027-01-25").type === "Deload" && at(Q, "2027-01-25").load < at(base, "2027-01-25").load,
  [at(Q, "2027-01-25").type, at(Q, "2027-01-25").load, at(base, "2027-01-25").load]);
check("one tired week alone changes nothing", at(withLog({ "2027-01-11": { fatigue: "tired" } }), "2027-01-18").load === at(base, "2027-01-18").load);
Q = withLog({ "2027-01-11": { health: "injured", affects: ["k"] } });
check("injured kneeling: no kneeling shots next week", at(Q, "2027-01-18").pos.k === 0 && at(Q, "2027-01-18").load <= 70, at(Q, "2027-01-18").pos);
Q = withLog({ "2027-01-11": { tech: "good", perf: "poor" } });
check("good technique, poor scores: more finals next week", at(Q, "2027-01-18").split.fin > at(base, "2027-01-18").split.fin);
Q = withLog({ "2027-01-11": { tech: "poor" } });
check("poor technique: fewer finals and lower intensity next week",
  at(Q, "2027-01-18").split.fin < at(base, "2027-01-18").split.fin && at(Q, "2027-01-18").inten < at(base, "2027-01-18").inten);
const expL = Math.round(at(base, "2027-01-11").load / 10);
Q = withLog({ "2027-01-11": { load: Math.min(10, expL + 3) } });
check("felt much harder than planned: next week down 15%", at(Q, "2027-01-18").load < at(base, "2027-01-18").load);
Q = withLog({ "2027-01-11": { load: Math.max(1, expL - 3), fatigue: "fresh", health: "fine" } });
const nx = at(base, "2027-01-18");
check("felt easier and fresh: next week steps up, unless it is a lighter week",
  /Deload|Taper|Step-down|Easy/.test(nx.type) ? at(Q, "2027-01-18").load === nx.load : at(Q, "2027-01-18").load > nx.load, [nx.type, nx.load, at(Q, "2027-01-18").load]);
Q = withLog({ "2027-01-11": { worked: ["k", "s"] }, "2027-01-18": { worked: ["k", "s", "ar"] } });
check("a position not worked on for two logged weeks is noted", at(Q, "2027-01-25").logAdj.some(x => x.rule === "coverage" && /Prone/.test(x.text)));
check("hand adjustments win over the log",
  at(withLog({ "2027-01-11": { health: "ill" } }, { adj: { "2027-01-18": { load: 90 } } }), "2027-01-18").load === 90);

/* ---------- feed maths against the README formulas ---------- */
/* reference normal CDF by numerical integration, independent of the page's approximation */
function PhiRef(x) {
  const n = 20000,
    lo = -10,
    h = (x - lo) / n;
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const t = lo + i * h,
      f = Math.exp((-t * t) / 2);
    s += i === 0 || i === n ? f / 2 : f;
  }
  return (s * h) / Math.sqrt(2 * Math.PI);
}
const bench = {
  compId: "c1", comp: "World Cup, Testville 2027", start: "2027-05-20", end: "2027-05-27", hz: 0.5,
  cut8: 631, cut8Lo: 629.5, cut8Hi: 632.5, sd8: 1.3, cut3: 633.5, cut3Lo: 632, cut3Hi: 635, sd3: 1.1,
  bronze: 229.5, nBronze: 12, venue: "testville", vOff8: -0.6, nVenue: 3, n: 40, nType: 8,
};
const fa = {
  id: "SHTSTW0101200001", name: "TEST Athlete", nation: "TST", n: 8, meanNow: 628.4, sd: 2.1, slope: 0.6,
  finals: 3, medals: 1, golds: 0, conv: 0.35, last: "2026-11-10",
  headline: { compId: "c1" },
  scores: [
    { d: "2026-10-12", c: "Lima 2026", l: "World Cup", s: 627.9, v: 628.8, p: 14 },
    { d: "2026-11-10", c: "Doha 2026", l: "World Championships", s: 629.1, v: 629.5, p: 9 },
  ],
};
const meta = { generated: "2026-11-16T10:00:00Z", fetched: "2026-11-16T11:00:00Z", calendar: [], chunks: ["AR10_W-0"] };
const F = assembleFeed([
  { id: "meta", data: meta },
  { id: "AR10_W-0", data: { event: "AR10_W", head: { label: "10m Air Rifle Women", benchmarks: [bench], venues: [] }, athletes: [fa] } },
]);
const who = { name: "Test", issfId: fa.id, training: [{ id: "t1", date: "2026-12-05", ev: "AR10_W", score: 630.2, note: "" }] };
const d = h => 1.5 * (1 - Math.exp(-h / 1.5));
const s8 = Math.hypot(fa.sd, bench.sd8),
  s3 = Math.hypot(fa.sd, bench.sd3);
const proj = fa.meanNow + fa.slope * d(bench.hz) + bench.vOff8;
for (const [conf, z] of [[50, 0], [70, 0.524], [85, 1.036]]) {
  const gF = goalCalc(who, { ev: "AR10_W", compId: "c1", out: "final", conf, start: "2026-11-16" }, F);
  const gM = goalCalc(who, { ev: "AR10_W", compId: "c1", out: "medal", conf, start: "2026-11-16" }, F);
  check(`projected level (${conf}%)`, near(gF.proj, proj, 1e-9), [gF.proj, proj]);
  check(`chance of the final (${conf}%)`, near(gF.pF, PhiRef((proj - bench.cut8) / s8), 1e-6), gF.pF);
  check(`chance of a medal, air rifle (${conf}%)`, near(gF.pM, PhiRef((proj - bench.cut8) / s8) * fa.conv, 1e-6), gF.pM);
  check(`level needed for the final (${conf}%)`, near(gF.need, bench.cut8 + z * s8, 1e-9), gF.need);
  check(`level needed for a medal (${conf}%)`, near(gM.need, bench.cut3 + z * s3, 1e-9), gM.need);
}
const g70 = goalCalc(who, { ev: "AR10_W", compId: "c1", out: "final", conf: 70, start: "2026-11-01" }, F);
check("start date before the feed date uses the current level", g70.L0 === fa.meanNow, g70.L0);
check("pathway ends at the needed level less the venue difference", near(g70.Lend, g70.need - bench.vOff8, 1e-9));
check("last milestone is the month before the target", g70.months[g70.months.length - 2].m === Date.UTC(2027, 3, 1),
  new Date(g70.months[g70.months.length - 2].m).toISOString());
check("milestones rise in a straight line", near(g70.months[g70.months.length - 2].mil, g70.Lend, 1e-9) && near(g70.months[0].mil, g70.L0, 1e-9));
const nov = g70.months.find(m => m.m === Date.UTC(2026, 10, 1));
check("monthly average uses the feed scores", nov && near(nov.adj, 629.5, 1e-9) && near(nov.raw, 629.1, 1e-9), nov && [nov.raw, nov.adj]);
check("status: above the milestone is on track", nov.status === "on", nov.status);
const dec = g70.months.find(m => m.m === Date.UTC(2026, 11, 1));
check("training scores roll up by month", dec && near(dec.trAvg, 630.2, 1e-9), dec && dec.trAvg);
const later = goalCalc(who, { ev: "AR10_W", compId: "c1", out: "final", conf: 70, start: "2027-01-15" }, F);
check("start date after the feed date uses the projected level",
  near(later.L0, fa.meanNow + fa.slope * d((parse("2027-01-15") - parse("2026-11-16")) / (365.25 * 864e5)), 1e-9), later.L0);

const ev = { type: "comp", name: "WM Doha QAT", disc: "10m", st: parse("2026-11-08"), en: parse("2026-11-12") };
check("feed score found by dates and city", (feedScore(who, ev, F).q10 || {}).s === 629.1, feedScore(who, ev, F));
check("feed score not taken for another city", !feedScore(who, Object.assign({}, ev, { name: "National match" }), F).q10);
check("feed score taken for a linked event", (feedScore(who, Object.assign({}, ev, { name: "WM", feedComp: "x" }), F).q10 || {}).s === 629.1);

/* ---------- week planner: drafted sessions add up to the week's targets ---------- */
{
  const draftWeek = run("draftWeek"),
    sessTotals = run("sessTotals"),
    weekDays = run("weekDays"),
    finTarget = run("finTarget");
  let worstH = 0,
    shotsOk = true,
    blockedOk = true,
    finOk = true,
    restOk = true,
    n = 0;
  for (const w of P.W) {
    const d = draftWeek(w, P),
      T = sessTotals(d),
      days = weekDays(w);
    if (!(w.hours > 0)) {
      if (d.length) blockedOk = false;
      continue;
    }
    n++;
    for (const k of ["t10", "t50", "phys", "mental", "rec"]) if (w.split[k] >= 0.4) worstH = Math.max(worstH, Math.abs(T[k] - w.split[k]));
    if (T.shots10 !== w.shots10 && T.t10 > 0) shotsOk = false;
    if (T.t50 > 0 && (T.k !== w.pos.k || T.p !== w.pos.p || T.s !== w.pos.s)) shotsOk = false;
    if (d.some(x => days[x.day].kind)) blockedOk = false;
    if (T.fin !== Math.min(finTarget(w), d.filter(x => x.type === "t10" || x.type === "t50").length)) finOk = false;
    if (days.every(x => !x.kind) && new Set(d.map(x => x.day)).size > 6) restOk = false;
  }
  check(`drafted hours per category are within 15 minutes of the target (${n} weeks)`, worstH <= 0.25, worstH);
  check("drafted shots add up exactly to the week's shots", shotsOk);
  check("no drafted sessions on holiday or competition days", blockedOk);
  check("drafted finals match the week's number of finals", finOk);
  check("a full training week keeps one rest day", restOk);
  const ew = wk("2027-03-08"),
    ed = weekDays(ew);
  check("competition days are marked in the peak week", ed.filter(x => x.kind === "comp").length === 5, ed.map(x => x.kind));
  check("holiday days are marked", weekDays(wk("2026-12-21")).every(x => x.kind === "hol"));
}

/* ---------- optional: every athlete in the real feed against its own headline numbers ---------- */
if (process.env.FEED_JSON) {
  const raw = JSON.parse(fs.readFileSync(process.env.FEED_JSON, "utf8"));
  const docs = [{ id: "meta", data: { generated: raw.generated, calendar: raw.calendar, chunks: Object.keys(raw.events) } }];
  for (const [k, e] of Object.entries(raw.events))
    docs.push({ id: k, data: { event: k, head: e, athletes: e.athletes.map(a => Object.assign({}, a, { scores: [] })) } });
  const RF = assembleFeed(docs);
  let n = 0;
  const worst = { proj: 0, pF: 0, pM: 0, need: 0 };
  for (const [k, E] of Object.entries(RF.events))
    for (const a of E.athletes) {
      const h = a.headline,
        c = goalCalc({ name: a.name, issfId: a.id, training: [] }, { ev: k, compId: h.compId, out: "final", conf: 70 }, RF);
      worst.proj = Math.max(worst.proj, Math.abs(c.proj - h.proj));
      worst.pF = Math.max(worst.pF, Math.abs(c.pF - h.pFinal));
      worst.pM = Math.max(worst.pM, Math.abs(c.pM - h.pMedal));
      worst.need = Math.max(worst.need, Math.abs(c.needF - h.reqFinal70));
      n++;
    }
  check(`real feed: ${n} athletes match their headline numbers within the feed's rounding`,
    worst.proj <= 0.15 && worst.pF <= 0.01 && worst.pM <= 0.01 && worst.need <= 0.1, worst);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
