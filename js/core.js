"use strict";
/* ================= dates ================= */
const DAY = 864e5,
  WEEK = 7 * DAY;
const parse = s => {
  const [y, m, d] = String(s).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const mondayOf = ms => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY;
const fmt = (ms, o) =>
  new Date(ms).toLocaleDateString(
    "en-GB",
    Object.assign({ day: "numeric", month: "short", timeZone: "UTC" }, o || {}),
  );
const range = (a, b) => (fmt(a) === fmt(b) ? fmt(a) : fmt(a) + " – " + fmt(b));
const esc = s =>
  String(s == null ? "" : s).replace(
    /[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r5 = v => Math.round(v / 5) * 5;

/* ================= defaults ================= */
const PH = {
  PP1: { n: "Preparation 1", s: "PREP 1" },
  PP2: { n: "Preparation 2", s: "PREP 2" },
  COMP: { n: "Competition", s: "COMP" },
  REC: { n: "Recovery", s: "REC" },
  AREC: { n: "Active recovery", s: "A-REC" },
  HOL: { n: "Holiday", s: "HOL" },
};
const DEF = {
  finals: { pp1: 5, pp2: 15, pre: 25, taper: 30 },
  shots: { r10: 55, rk: 65, rp: 75, rs: 45, k: 35, p: 25, s: 40 },
  taperPeak: 2,
  majorTaperDays: 4,
  recoveryWeeks: 2,
  clusterGap: 4,
  pp2Max: 10,
  split: {
    PP1: { sport: 45, phys: 35, mental: 10, rec: 10 },
    PP2: { sport: 60, phys: 20, mental: 12, rec: 8 },
    COMP: { sport: 55, phys: 12, mental: 18, rec: 15 },
    REC: { sport: 0, phys: 30, mental: 10, rec: 60 },
    AREC: { sport: 20, phys: 40, mental: 10, rec: 30 },
  },
};
const settingsOf = a => {
  const s = Object.assign({}, DEF, a.settings || {});
  s.split = Object.assign({}, DEF.split, (a.settings || {}).split || {});
  s.shots = Object.assign({}, DEF.shots, (a.settings || {}).shots || {});
  s.finals = Object.assign({}, DEF.finals, (a.settings || {}).finals || {});
  return s;
};
const PROG = { 1: [85], 2: [80, 90], 3: [80, 90, 65], 4: [75, 85, 95, 65], 5: [70, 80, 90, 95, 65] };
const REG = { 1: [90], 2: [100, 85], 3: [95, 100, 85], 4: [90, 100, 95, 85], 5: [85, 95, 100, 95, 85] };
const sizes = (n, nb) => {
  nb = Math.max(1, nb);
  const b = Math.floor(n / nb),
    r = n % nb;
  return Array.from({ length: nb }, (_, i) => b + (i < r ? 1 : 0));
};

/* ================= periodisation engine ================= */
function plan(a) {
  const S = settingsOf(a),
    N = clamp(parseInt(a.weeks) || 52, 8, 104),
    hmax = Number(a.hoursMax) || 30;
  const s0 = mondayOf(parse(a.seasonStart)),
    wi = ms => Math.floor((ms - s0) / WEEK),
    flags = [];
  const W = Array.from({ length: N }, (_, i) => ({
    i,
    start: s0 + i * WEEK,
    phase: "PP1",
    cyc: null,
    events: [],
    tags: [],
    load: 80,
    inten: 4,
    type: "Build",
  }));
  const evs = [];
  (a.events || []).forEach(e => {
    if (!e.start) return;
    const st = parse(e.start),
      en = Math.max(st, parse(e.end || e.start));
    const x = Object.assign({}, e, { st, en, w0: wi(st), w1: wi(en) });
    if (x.w1 < 0 || x.w0 >= N) {
      flags.push({
        lv: "info",
        w: null,
        t: `${e.name} (${fmt(st, { year: "numeric" })}) is outside this season, so it is not planned for.`,
      });
      return;
    }
    x.w0 = clamp(x.w0, 0, N - 1);
    x.w1 = clamp(x.w1, 0, N - 1);
    evs.push(x);
    for (let w = x.w0; w <= x.w1; w++) W[w].events.push(x);
  });
  /* a week with 5 or more holiday days is a holiday week: no training, and it does not count as preparation */
  W.forEach(w => {
    const d = new Set();
    w.events
      .filter(e => e.type === "hol")
      .forEach(e => {
        for (let x = Math.max(e.st, w.start); x <= Math.min(e.en, w.start + 6 * DAY); x += DAY) d.add(x);
      });
    w.holDays = d.size;
  });
  const isHolW = w => w.holDays >= 5;
  const peaks = evs.filter(e => e.type === "comp" && e.tier === "peak").sort((x, y) => x.w0 - y.w0);
  const clusters = [];
  peaks.forEach(p => {
    const c = clusters[clusters.length - 1];
    if (c && p.w0 - c.end - 1 <= S.clusterGap) {
      c.peaks.push(p);
      c.end = Math.max(c.end, p.w1);
    } else clusters.push({ peaks: [p], first: p.w0, end: p.w1 });
  });
  const recPhases = (from, R) => {
    const nRec = R >= 4 ? 2 : 1;
    for (let k = 0; k < R && from + k < N; k++) W[from + k].phase = k < nRec ? "REC" : "AREC";
  };
  const prepSplit = n =>
    n <= 8
      ? [0, n]
      : n <= 11
        ? [n - 6, 6]
        : [n - Math.min(S.pp2Max, Math.round(n / 2)), Math.min(S.pp2Max, Math.round(n / 2))];
  let lower = 0,
    prev = null;
  clusters.forEach((c, ci) => {
    const nm = c.peaks[0].name,
      wantT = clamp(parseInt(c.peaks[0].taper) || S.taperPeak, 1, 4);
    const wantR = prev ? S.recoveryWeeks + (prev.end - prev.compStart + 1 >= 5 ? 1 : 0) : 0;
    let T = wantT,
      R = wantR;
    const avail = c.first - lower;
    if (avail < R + 3 + T) {
      R = Math.max(prev ? 1 : 0, Math.min(R, avail - 3 - T));
      if (avail - R - T < 2) T = Math.max(1, Math.min(T, avail - R - 2));
      R = clamp(R, 0, avail);
      T = clamp(T, 0, avail - R);
    }
    c.T = T;
    c.compStart = c.first - T;
    c.idx = ci;
    const n0 = c.first - T - lower - R,
      wkn = i => `week ${i + 1} (${fmt(s0 + i * WEEK)})`,
      pl = (v, u) => v + " " + u + (v === 1 ? "" : "s");
    const ctx = prev
      ? [
          `${prev.peaks[prev.peaks.length - 1].name} ends in ${wkn(prev.end)} and ${nm} starts in ${wkn(c.first)}. That leaves ${pl(avail, "full week")} between them.`,
          `A complete cycle between two peaks needs ${pl(wantR, "week")} of recovery, at least 3 weeks of build and ${pl(wantT, "week")} of taper: ${wantR + 3 + wantT} weeks in total.`,
          `With ${avail} available, the plan gives ${pl(R, "week")} to recovery, ${pl(Math.max(0, n0), "week")} to build and ${pl(T, "week")} to taper.`,
          `When weeks are short it cuts in this order: recovery first (down to one week), then the taper (down to one week), then the build. The taper is protected longest because it has the most direct effect on the next result, and a build of under two weeks would mean arriving at ${nm} with no specific preparation.`,
          `Other ways to handle it: make one of the two events a major for this athlete, so it gets a mini-taper and no recovery block. Or set "Peaks within this many weeks share one competition phase" to ${avail} or more under Planning rules, so both events sit in one competition phase with maintenance weeks between them. Or set the weeks by hand in their week cards.`,
        ]
      : [
          `The season starts in ${wkn(0)} and ${nm} starts in ${wkn(c.first)}. That leaves ${pl(avail, "full week")} before it.`,
          `A full build needs at least 6 weeks of preparation before a ${pl(wantT, "week")} taper. Here the plan gives ${pl(Math.max(0, n0), "week")} to build and ${pl(T, "week")} to taper.`,
          `Other ways to handle it: move the season start earlier so the weeks before this event are planned, or make the event a major for this athlete if it is not a true peak.`,
        ];
    if (R < wantR)
      flags.push({
        lv: "warn",
        d: ctx,
        w: lower,
        t: `Recovery after ${prev.peaks[prev.peaks.length - 1].name} is cut from ${wantR} to ${R} week${R === 1 ? "" : "s"} because ${nm} follows ${avail} weeks later. Protect the first days off the range and watch for staleness.`,
      });
    if (T < wantT)
      flags.push({
        lv: "warn",
        d: ctx,
        w: c.compStart,
        t: `Taper for ${nm} is shortened from ${wantT} to ${T} week${T === 1 ? "" : "s"} because there is not enough room before it.`,
      });
    recPhases(lower, R);
    const pStart = lower + R,
      nHol = W.slice(pStart, Math.max(pStart, c.compStart)).filter(isHolW).length,
      n = c.compStart - pStart - nHol,
      [p1, p2] = prepSplit(Math.max(0, n));
    c.avail = avail;
    c.cut = !!prev && (R < wantR || T < wantT || n < 6);
    for (let w = pStart, k = 0; w < c.compStart; w++) {
      W[w].cyc = ci;
      if (isHolW(W[w])) {
        W[w].phase = "HOL";
        continue;
      }
      W[w].phase = k < p1 ? "PP1" : "PP2";
      k++;
    }
    for (let w = c.compStart; w <= c.end; w++) {
      W[w].phase = "COMP";
      W[w].cyc = ci;
    }
    if (n < 6)
      flags.push({
        lv: "warn",
        d: ctx,
        w: pStart,
        t: `Only ${Math.max(0, n)} week${n === 1 ? "" : "s"} of build before the competition phase for ${nm}. The plan skips general preparation and goes straight to competition-specific work; treat fitness as maintenance only.`,
      });
    if (p1 > 12)
      flags.push({
        lv: "info",
        w: pStart,
        t: `Long general preparation (${p1} weeks) before ${nm}. This is the window for technique changes, position rebuilds and equipment or ammunition testing. A major competition in the middle would give a useful checkpoint.`,
      });
    const cl = c.end - c.compStart + 1;
    if (cl > 6)
      flags.push({
        lv: "info",
        d: [
          `Peaks in this phase: ${c.peaks.map(p => p.name + " (" + range(p.st, p.en) + ")").join("; ")}.`,
          `They are planned as one competition phase because each starts within ${pl(S.clusterGap, "week")} of the previous one ending (the setting under Planning rules). That is too little time for recovery, a new build and a taper in between.`,
          `Between the peaks the plan holds volume at about 80% for a top-up, then tapers again before each one.`,
          `Other ways to handle it: make one of the events a major for this athlete. Or lower the "share one competition phase" setting so they are planned as separate cycles, which will shorten the recovery and build between them and raise its own conflict.`,
        ],
        w: c.compStart,
        t: `The competition phase around ${nm} runs ${cl} weeks (${c.peaks.length} peak events). Peak form is hard to hold beyond about 5 weeks, so consider marking one of these events as major instead of peak.`,
      });
    lower = c.end + 1;
    prev = c;
  });
  if (prev) {
    const R = Math.min(S.recoveryWeeks + (prev.end - prev.compStart + 1 >= 5 ? 1 : 0), N - lower);
    recPhases(lower, R);
  } else
    flags.push({
      lv: "warn",
      w: null,
      t: "No peak competition in this season yet. Add at least one peak event and the year will be built backwards from it. Until then the whole season is shown as general preparation.",
    });
  W.forEach(w => {
    if (isHolW(w) && w.phase !== "COMP") w.phase = "HOL";
  });

  /* key events: a short specific build, a one-week taper and one easy week after, without starting a new cycle */
  evs
    .filter(e => e.type === "comp" && e.tier === "key")
    .sort((x, y) => x.w0 - y.w0)
    .forEach(e => {
      const carry =
          e.w0 > 0 && e.w0 <= 4 && W.slice(0, e.w0).every(w => w.phase === "PP1" || w.phase === "PP2"),
        from = carry ? 0 : Math.max(0, e.w0 - 3),
        to = Math.min(N - 1, e.w1 + 1);
      const bad = W.slice(from, to + 1).find(
        w => w.phase === "COMP" || w.phase === "REC" || w.phase === "AREC" || w.keyEv || w.keyAfter,
      );
      if (bad) {
        e.keyOK = false;
        const pc = bad.cyc != null ? clusters[bad.cyc] : null,
          pn = pc ? pc.peaks[0].name : "the peak";
        flags.push({
          lv: "info",
          w: e.w0,
          t: `${e.name} is a key event, but ${bad.keyEv || bad.keyAfter ? "it is too close to " + (bad.keyEv || bad.keyAfter).name + ", another key event" : bad.phase === "COMP" ? "it runs into the taper and competition phase for " + pn : "it runs into the recovery period after " + pn}. ${W[e.w0].phase === "PP1" || W[e.w0].phase === "PP2" ? "It gets a short taper inside the build instead: a lighter week before it, a deeper cut in the event week and easy days after." : W[e.w0].phase === "COMP" ? "It is planned inside that competition phase instead, as a rehearsal at taper volume." : "It falls in a recovery period, so it is planned as a competition inside it; see the conflict for that week."}`,
          d: [
            `A key event takes the 3 weeks before it for specific preparation and a one-week taper, and the week after it as an easy week. Here that window overlaps ${bad.keyEv || bad.keyAfter ? "the window of " + (bad.keyEv || bad.keyAfter).name : bad.phase === "COMP" ? "the taper and competition phase for " + pn : "the recovery period after " + pn}, which the plan protects.`,
            `Other ways to handle it: make it a peak if it matters as much as ${pn}, so the two are planned together. Or make it a major, so it only gets a mini-taper. Or set the weeks around it by hand in their week cards.`,
          ],
        });
        return;
      }
      e.keyOK = true;
      for (let i = from; i < e.w0 - 1; i++) {
        if (W[i].phase === "HOL") continue;
        W[i].phase = "PP2";
        W[i].keyPrep = e;
        if (carry) W[i].carry = true;
      }
      for (let i = Math.max(0, e.w0 - 1); i <= e.w1; i++) {
        W[i].phase = "COMP";
        W[i].keyEv = e;
      }
      if (e.w1 + 1 < N) W[e.w1 + 1].keyAfter = e;
      if (carry)
        flags.push({
          lv: "info",
          w: 0,
          t: `${e.name} is a key event ${e.w0} week${e.w0 === 1 ? "" : "s"} after the season starts. The weeks before it hold form from the previous season instead of starting general preparation, then taper for one week. General preparation starts after it.`,
        });
    });

  /* hand adjustments: phase */
  const ADJ = a.adj || {};
  W.forEach(w => {
    const j = ADJ[iso(w.start)];
    if (j && PH[j.phase] && j.phase !== w.phase) {
      w.phase = j.phase;
      w.manual = true;
    }
  });

  /* mesocycle blocks */
  const grp = w => (w.phase === "REC" || w.phase === "AREC" ? "RECV" : w.phase) + "|" + w.cyc,
    blocks = [];
  for (let i = 0; i < N; ) {
    let j = i;
    while (j + 1 < N && grp(W[j + 1]) === grp(W[i])) j++;
    const n = j - i + 1,
      ph = W[i].phase,
      g = grp(W[i]).split("|")[0];
    const sz = g === "RECV" ? [n] : g === "COMP" ? sizes(n, Math.ceil(n / 6)) : sizes(n, Math.round(n / 4));
    let s = i;
    sz.forEach((len, k) => {
      const fin = ph === "PP2" && k === sz.length - 1 && j + 1 < N && W[j + 1].phase === "COMP";
      blocks.push({ start: s, len, phase: g, final: fin, segStart: i, segLen: n });
      s += len;
    });
    i = j + 1;
  }
  blocks.forEach((b, bi) => {
    const afterRec = b.start === 0 || ["REC", "AREC", "HOL"].includes(W[b.start - 1].phase);
    for (let k = 0; k < b.len; k++) {
      const w = W[b.start + k];
      w.block = bi;
      const frac = b.segLen > 1 ? (w.i - b.segStart) / (b.segLen - 1) : 1;
      if (b.phase === "PP1" || b.phase === "PP2") {
        const pat = (b.final ? REG : PROG)[Math.min(5, b.len)],
          v = pat[Math.min(k, pat.length - 1)],
          mx = Math.max(...pat);
        w.load = r5(v * (afterRec ? 0.9 : 1));
        w.type = b.final
          ? v === mx
            ? "Overreach"
            : k > pat.indexOf(mx)
              ? "Step-down"
              : "Build"
          : b.len >= 3 && k === b.len - 1
            ? "Deload"
            : v === mx
              ? "Peak load"
              : "Build";
        w.inten =
          Math.round(b.phase === "PP1" ? 3 + frac * 1.5 : 5 + frac * 2.5) - (w.type === "Deload" ? 1 : 0);
      } else if (b.phase === "RECV") {
        w.load = w.phase === "REC" ? 20 : 40;
        w.inten = w.phase === "REC" ? 1 : 2;
        w.type = w.phase === "REC" ? "Time off" : "Active recovery";
      } else if (b.phase === "HOL") {
        w.load = 0;
        w.inten = 1;
        w.type = "Holiday";
      } else if (w.keyEv) {
        if (w.i >= w.keyEv.w0) {
          w.load = 50;
          w.inten = 9;
          w.type = "Key competition";
        } else {
          w.load = 65;
          w.inten = 8;
          w.type = "Key taper";
        }
      } else {
        const c = w.cyc == null ? null : clusters[w.cyc],
          p = c && c.peaks.find(p => p.w1 >= w.i);
        if (!p) {
          w.load = 80;
          w.inten = 7;
          w.type = "Maintain";
        } else if (w.i >= p.w0) {
          w.load = 50;
          w.inten = 9;
          w.type = "Peak competition";
        } else {
          const kk = p.w0 - w.i,
            Tp = p === c.peaks[0] ? c.T : clamp(parseInt(p.taper) || S.taperPeak, 1, 4);
          if (kk <= Tp) {
            w.load = r5(48 + (27 * kk) / Tp);
            w.inten = 8;
            w.type = "Taper";
          } else {
            w.load = 80;
            w.inten = 7;
            w.type = "Maintain";
          }
        }
      }
    }
    b.pattern =
      b.phase === "RECV"
        ? "Recovery"
        : b.phase === "HOL"
          ? "Holiday, no training"
          : b.phase === "COMP"
            ? "Taper and compete"
            : b.final
              ? "Regressive: overreach, then step down"
              : b.len >= 3
                ? "Progressive " + (b.len - 1) + ":1"
                : "Progressive";
  });

  const finalWk = w => {
    const c = w.cyc == null ? null : clusters[w.cyc],
      p = c && c.peaks.find(p => p.w1 >= w.i);
    return p && p.w0 - w.i === 1 ? p : null;
  };
  const recWhy = w => {
    let a0 = w.i,
      b0 = w.i;
    const isR = x => x.phase === "REC" || x.phase === "AREC",
      pl = (v, u) => v + " " + u + (v === 1 ? "" : "s");
    while (a0 > 0 && isR(W[a0 - 1])) a0--;
    while (b0 < N - 1 && isR(W[b0 + 1])) b0++;
    const pc = a0 > 0 && W[a0 - 1].cyc != null ? clusters[W[a0 - 1].cyc] : null,
      pn = pc ? pc.peaks[pc.peaks.length - 1].name : "the peak";
    return [
      `Recovery runs from week ${a0 + 1} (${fmt(W[a0].start)}) to week ${b0 + 1} (${fmt(W[b0].start + 6 * DAY)}), straight after ${pn}.`,
      `It is ${pl(b0 - a0 + 1, "week")} long. Planning rules ask for ${pl(S.recoveryWeeks, "week")} after a peak, one more after a competition phase of 5 weeks or longer, and fewer only when the next peak is too close. The first part is time off the range and the rest is active recovery.`,
      `The plan does not move recovery for an event that is not a peak. This period exists so the athlete recovers from the peak before the next build starts, and training or competing through it carries the fatigue into that build.`,
      `Other ways to handle it: switch the event off for this athlete. Or shorten "Recovery after a peak" under Planning rules. Or set these weeks to another phase by hand in their week cards.`,
    ];
  };

  W.forEach(w => {
    if (w.carry && w.phase === "PP2") {
      w.load = Math.min(w.load, 80);
      w.type = "Hold form";
    }
    if (w.keyAfter && (w.phase === "PP1" || w.phase === "PP2")) {
      w.load = Math.min(w.load, 60);
      w.inten = Math.min(w.inten, 3);
      w.type = "Easy week";
    }
  });

  /* event adjustments and conflicts */
  W.forEach(w => {
    const comps = w.events.filter(e => e.type === "comp"),
      camps = w.events.filter(e => e.type === "camp"),
      prep = w.phase === "PP1" || w.phase === "PP2",
      recv = w.phase === "REC" || w.phase === "AREC";
    const first = e => e.w0 === w.i;
    comps.forEach(e => {
      if (e.tier === "major" || (e.tier === "key" && !e.keyOK)) {
        if (prep) {
          if (w.type === "Overreach" && first(e))
            flags.push({
              lv: "info",
              w: w.i,
              t: `${e.name} lands in the heaviest week of the build. The week is lightened for it; expect some fatigue in the result, or shift the heavy week earlier.`,
            });
          if (e.tier === "key") {
            if (w.type !== "Deload") w.load = Math.min(w.load, Math.max(55, r5(w.load * 0.65)));
            w.inten = 9;
            if (!w.tags.includes("Key event")) w.tags.push("Key event");
            const pw = W[w.i - 1],
              nw = W[w.i + 1],
              isP = x => x && (x.phase === "PP1" || x.phase === "PP2");
            if (first(e) && isP(pw) && !pw.tags.includes("Short taper") && !pw.tags.includes("Key event")) {
              pw.load = Math.min(pw.load, Math.max(65, r5(pw.load * 0.8)));
              pw.inten = Math.max(pw.inten, 8);
              pw.tags.push("Short taper");
            }
            if (e.w1 === w.i && isP(nw)) {
              nw.load = Math.min(nw.load, 80);
              nw.tags.push("Easy days first");
            }
          } else {
            if (w.type !== "Deload") w.load = Math.min(w.load, Math.max(70, r5(w.load * 0.82)));
            w.inten = Math.max(w.inten, 8);
            w.tags.push("Mini-taper");
          }
        } else if (w.phase === "COMP" && w.type !== "Peak competition") {
          w.tags.push("Rehearsal");
          const np = finalWk(w);
          if (first(e))
            flags.push(
              np
                ? {
                    lv: "warn",
                    w: w.i,
                    t: `${e.name} is a major competition in the final week of the taper, ${Math.max(0, Math.round((np.st - e.en) / DAY))} days before ${np.name} starts. Travel and a full competition effort here work against the taper. Make it a minor rehearsal for this athlete, or leave it out.`,
                  }
                : {
                    lv: "info",
                    w: w.i,
                    t: `${e.name} falls inside the competition phase. Use it as the final rehearsal of the peak routine and keep the surrounding volume at taper level.`,
                  },
            );
        } else if (recv && first(e))
          flags.push({
            lv: "warn",
            w: w.i,
            t: `${e.name} is a major competition inside a recovery period. Either downgrade it, move it, or accept a shortened recovery.`,
            d: recWhy(w),
          });
      } else if (e.tier === "small") {
        if (recv) {
          if (first(e))
            flags.push({
              lv: "warn",
              w: w.i,
              t: `${e.name} falls in a recovery period. Skip it, or shoot it with no result expectation.`,
              d: recWhy(w),
            });
        } else {
          w.tags.push("Train through");
          if (prep) w.inten = Math.min(10, w.inten + 1);
          const np = w.phase === "COMP" && finalWk(w);
          if (np && first(e))
            flags.push({
              lv: "info",
              w: w.i,
              t: `${e.name} is in the final week of the taper, ${Math.max(0, Math.round((np.st - e.en) / DAY))} days before ${np.name} starts. Keep it as a short, low-pressure rehearsal with no travel, or leave it out.`,
            });
        }
      }
    });
    camps.forEach(e => {
      if (prep) {
        if (w.type === "Deload") {
          w.load = Math.max(w.load, 90);
          w.type = "Camp load";
          if (first(e))
            flags.push({
              lv: "info",
              w: w.i,
              t: `${e.name} lands on a planned deload week. The camp is treated as load, so schedule two or three light days straight after it.`,
            });
        } else w.load = Math.max(w.load, Math.min(100, w.load + 10));
        w.tags.push("Camp");
      } else if (w.phase === "COMP") {
        w.tags.push("Camp");
        if (first(e))
          flags.push({
            lv: "info",
            w: w.i,
            t: `${e.name} is inside the competition phase. Run it as a pre-competition camp at taper volume: short, sharp sessions and match rehearsal, no extra load.`,
          });
      } else if (first(e))
        flags.push({
          lv: "warn",
          w: w.i,
          t: `${e.name} falls in a recovery period, when the athlete should be off the range. Move the camp or the recovery.`,
          d: recWhy(w),
        });
    });
  });

  /* holidays: days with no training */
  W.forEach(w => {
    const hs = w.events.filter(e => e.type === "hol");
    if (!hs.length) return;
    const days = new Set();
    hs.forEach(e => {
      for (let d = Math.max(e.st, w.start); d <= Math.min(e.en, w.start + 6 * DAY); d += DAY) days.add(d);
    });
    w.hol = days.size;
    hs.filter(e => e.w0 === w.i).forEach(e => {
      const n = Math.round((e.en - e.st) / DAY) + 1,
        ws = W.slice(e.w0, e.w1 + 1),
        c = ws
          .map(x => x.cyc)
          .filter(x => x != null)
          .map(x => clusters[x])[0],
        nm = c ? c.peaks[0].name : "the next peak",
        d = n + " day" + (n === 1 ? "" : "s");
      evs
        .filter(x => x.type !== "hol" && x.st <= e.en && x.en >= e.st)
        .forEach(x =>
          flags.push({
            lv: "warn",
            w: w.i,
            t: `${e.name} overlaps ${x.name}. The athlete cannot be on holiday and at the ${x.type === "camp" ? "camp" : "competition"}; move one of them or switch one off for this athlete.`,
          }),
        );
      if (ws.some(x => x.phase === "COMP"))
        flags.push({
          lv: "warn",
          w: w.i,
          t: `${e.name} (${d} off) falls in the taper or competition phase for ${nm}. A break here costs sharpness. The best place for it is the recovery period straight after the event.`,
        });
      else if (ws.some(x => x.type === "Overreach" || x.type === "Step-down"))
        flags.push({
          lv: "warn",
          w: w.i,
          t: `${e.name} (${d} off) falls in the last build block before ${nm} and interrupts the overreach and step-down. Move it earlier in the build, or into the recovery period after the event.`,
        });
      else if (n >= 4 && ws.some(x => x.phase === "PP1" || x.phase === "PP2" || x.phase === "HOL"))
        flags.push({
          lv: "info",
          w: w.i,
          t: `${e.name} takes ${d} out of the build. ${ws.some(x => x.phase === "HOL") ? "Its full weeks are planned as holiday with no training, the preparation phases are counted on the training weeks around it, and the first week back is capped" : "It is treated as the lighter week of its block, and the week after is capped"} so the athlete eases back in.`,
        });
    });
    w.load = w.hol >= 6 ? 0 : r5((w.load * (7 - w.hol)) / 7);
    if (w.hol >= 6) w.inten = 1;
    if (w.hol >= 5) w.type = "Holiday";
    w.tags.push(w.hol >= 7 ? "No training" : w.hol + " day" + (w.hol === 1 ? "" : "s") + " off");
  });
  W.forEach(w => {
    const n = W[w.i + 1];
    if (w.hol >= 5 && n && !n.hol && (n.phase === "PP1" || n.phase === "PP2")) {
      if (n.type === "Deload") {
        n.type = "Build";
        n.load = 75;
      } else n.load = Math.min(n.load, 80);
      n.tags.push("Ease back in");
    }
  });

  /* competition days: nothing is planned on them, the plan only covers the build-up and the recovery */
  W.forEach(w => {
    const cs = w.events.filter(e => e.type === "comp");
    if (!cs.length) return;
    const hd = new Set(),
      cd = new Set(),
      we = w.start + 6 * DAY;
    w.events
      .filter(e => e.type === "hol")
      .forEach(e => {
        for (let d = Math.max(e.st, w.start); d <= Math.min(e.en, we); d += DAY) hd.add(d);
      });
    cs.forEach(e => {
      for (let d = Math.max(e.st, w.start); d <= Math.min(e.en, we); d += DAY) if (!hd.has(d)) cd.add(d);
    });
    w.compDays = cd.size;
    if (!cd.size) return;
    const left = 7 - hd.size,
      tr = Math.max(0, left - cd.size);
    w.load = tr <= 1 ? 0 : r5((w.load * tr) / Math.max(1, left));
    if (tr <= 1 && w.type !== "Peak competition" && w.type !== "Key competition") w.type = "Competition week";
  });

  /* weekly log: what the coach recorded about a week adjusts the following week.
     Each adjustment is listed on that week's card and can be ignored; hand adjustments still win. */
  const LOG = a.wlog || {},
    IGN = a.logIgnore || {},
    POSN = { ar: "air rifle", k: "kneeling", p: "prone", s: "standing" },
    tiredL = l => l && (l.fatigue === "tired" || l.fatigue === "very");
  W.forEach(w => {
    w.log = LOG[iso(w.start)] || null;
    w.logAdj = [];
  });
  const adjust = (n, from, rule, text, fn) => {
    if (!n || n.phase === "HOL") return;
    const key = iso(n.start) + "|" + rule,
      ign = !!IGN[key];
    n.logAdj.push({ key, rule, text, ign, from: from.i });
    if (!ign && fn) fn(n);
  };
  W.forEach(w => {
    const l = w.log,
      n = W[w.i + 1];
    if (!l || !n) return;
    const aff = (l.affects || []).filter(x => POSN[x]),
      affT = aff.length ? ` (${aff.map(x => POSN[x]).join(", ")})` : "";
    let cut = false;
    if (l.health === "ill") {
      cut = true;
      adjust(n, w, "ill", "Ill last week: volume capped at 50%, intensity at most 4, no finals work.", x => {
        x.load = Math.min(x.load, 50);
        x.inten = Math.min(x.inten, 4);
        x.noFin = true;
      });
    } else if (l.health === "injured") {
      cut = true;
      adjust(n, w, "injured", `Injured last week${affT}: volume capped at 70%${aff.length ? ", and the affected shooting is left out" : ""}.`, x => {
        x.load = Math.min(x.load, 70);
        x.avoid = aff;
      });
    } else if (l.health === "niggle") {
      cut = true;
      adjust(n, w, "niggle", `A niggle last week${affT}: volume capped at 85%${aff.length ? ", and the affected shooting is halved" : ""}.`, x => {
        x.load = Math.min(x.load, 85);
        x.reduce = aff;
      });
    }
    const prev = W[w.i - 1] && W[w.i - 1].log;
    if ((tiredL(l) && tiredL(prev)) || (l.fatigue === "very" && +l.load >= 8)) {
      cut = true;
      adjust(n, w, "fatigue", tiredL(prev) ? "Tired two weeks running: next week becomes a deload." : "Very tired after a hard week: next week becomes a deload.", x => {
        x.load = Math.min(x.load, Math.max(50, r5(x.load * 0.7)));
        x.inten = Math.max(1, x.inten - 1);
        if (x.phase === "PP1" || x.phase === "PP2") x.type = "Deload";
      });
    }
    const exp = Math.round(w.load / 10);
    if (+l.load > 0 && w.load > 0) {
      if (+l.load >= exp + 3 || (+l.load >= 9 && +l.load >= exp + 2)) {
        cut = true;
        adjust(n, w, "harder", `The week felt much harder than planned (${l.load}/10 against about ${exp}/10): next week's volume is down 15%.`, x => {
          x.load = r5(x.load * 0.85);
        });
      } else if (!cut && +l.load <= exp - 3 && (l.fatigue === "fresh" || l.fatigue === "normal") && (l.health || "fine") === "fine" &&
        (n.phase === "PP1" || n.phase === "PP2") && !/Deload|Taper|Step-down|Easy/.test(n.type)) {
        adjust(n, w, "easier", `The week felt easier than planned (${l.load}/10 against about ${exp}/10) and the athlete is fresh: next week steps up 10%.`, x => {
          x.load = Math.min(100, r5(x.load * 1.1));
        });
      }
    }
    if (l.tech === "good" && l.perf === "poor" && l.health !== "ill")
      adjust(n, w, "transfer", "Technique went well but the scores did not: next week has more competition simulations and finals, with match routines and mental work.", x => {
        x.finBoost = true;
      });
    else if (l.tech === "poor")
      adjust(n, w, "technical", `Technical work did not go well${l.perf === "poor" ? ", and neither did the scores" : ""}: next week leans to technical work, with half the finals and slightly lower intensity.`, x => {
        x.techFocus = true;
        x.inten = Math.max(1, x.inten - 1);
      });
    /* positions not worked on in two logged build weeks running (3P athletes) */
    if (prev && l.worked && prev.worked && (w.phase === "PP1" || w.phase === "PP2")) {
      const miss = ["k", "p", "s"].filter(x => !l.worked.includes(x) && !prev.worked.includes(x));
      if (miss.length && miss.length < 3 && (l.worked.some(x => ["k", "p", "s"].includes(x)) || prev.worked.some(x => ["k", "p", "s"].includes(x))))
        adjust(n, w, "coverage", `${miss.map(x => POSN[x][0].toUpperCase() + POSN[x].slice(1)).join(" and ")} ${miss.length > 1 ? "have" : "has"} not been worked on for two logged weeks: plan some time for ${miss.length > 1 ? "them" : "it"} next week.`, null);
    }
  });

  /* hand adjustments: volume and intensity */
  W.forEach(w => {
    w.autoLoad = w.load;
    w.autoInten = w.inten;
    const j = ADJ[iso(w.start)];
    if (!j) return;
    if (j.load != null && j.load !== "") {
      w.load = clamp(+j.load || 0, 0, 110);
      w.manual = true;
    }
    if (j.inten != null && j.inten !== "") {
      w.inten = clamp(Math.round(+j.inten) || 1, 1, 10);
      w.manual = true;
    }
  });

  /* hours and content split */
  const disc = c => {
    const d = new Set(c.map(p => p.disc));
    return d.has("both") || d.size > 1 ? "both" : [...d][0];
  };
  W.forEach(w => {
    const c = w.cyc == null ? null : clusters[w.cyc];
    w.next = c ? c.peaks.find(p => p.w1 >= w.i) || null : null;
    let tgt = "both";
    if (c) tgt = w.phase === "COMP" && w.next ? w.next.disc : disc(c.peaks);
    if (w.keyEv || w.keyPrep) tgt = (w.keyEv || w.keyPrep).disc;
    const b = { PP1: 0.6, PP2: 0.7, COMP: 0.85 }[w.phase] || 0.5;
    let sh = tgt === "both" ? 0.5 : tgt === "10m" ? b : 1 - b;
    if (w.phase === "PP1" || w.phase === "PP2") {
      const near = [w, W[w.i + 1]]
        .filter(Boolean)
        .flatMap(x => x.events)
        .filter(e => e.type === "comp" && e.tier !== "small");
      if (near.length) {
        const d = disc(near);
        if (d === "10m") sh = Math.max(sh, 0.65);
        if (d === "50m") sh = Math.min(sh, 0.35);
      }
    }
    if (w.phase === "PP1" && (a.strength === "10m" || a.strength === "50m"))
      sh = clamp(sh + (a.strength === "10m" ? -0.1 : 0.1), 0.2, 0.8);
    w.share10 = sh;
    const off = x => (w.avoid || []).includes(x),
      half = x => (w.reduce || []).includes(x);
    if (off("ar")) w.share10 = 0;
    else if (off("k") && off("p") && off("s")) w.share10 = 1;
    else if (half("ar")) w.share10 = w.share10 / 2;
    w.target = tgt;
    w.hours = Math.round(((hmax * w.load) / 100) * 2) / 2;
    const sp = S.split[w.phase] || { sport: 0, phys: 0, mental: 0, rec: 1 },
      tot = (+sp.sport || 0) + (+sp.phys || 0) + (+sp.mental || 0) + (+sp.rec || 0) || 1,
      h = k => (w.hours * (+sp[k] || 0)) / tot;
    w.split = {
      t10: h("sport") * sh,
      t50: h("sport") * (1 - sh),
      phys: h("phys"),
      mental: h("mental"),
      rec: h("rec"),
    };
    const soon = [w, W[w.i + 1], W[w.i + 2]]
      .filter(Boolean)
      .some(x => x.events.some(e => e.type === "comp" && e.tier !== "small"));
    w.finKind =
      w.phase === "REC" || w.phase === "AREC" || w.phase === "HOL"
        ? null
        : w.phase === "COMP"
          ? w.type === "Peak competition" || w.type === "Key competition"
            ? "pre"
            : "taper"
          : soon || w.type === "Overreach" || w.type === "Step-down"
            ? "pre"
            : w.phase === "PP2"
              ? "pp2"
              : "pp1";
    w.split.fin =
      w.finKind && !w.noFin
        ? ((w.split.t10 + w.split.t50) * clamp((+S.finals[w.finKind] || 0) + (w.finBoost ? 10 : 0), 0, 100)) / 100
        : 0;
    if (w.techFocus) w.split.fin /= 2;
    const so = S.shots,
      pf = w.phase === "PP1" ? 0.8 : 1,
      r10 = v => Math.round(v / 10) * 10,
      wt = x => (+so[x] || 0) * ((w.avoid || []).includes(x) ? 0 : (w.reduce || []).includes(x) ? 0.5 : 1),
      pt = wt("k") + wt("p") + wt("s") || 1;
    w.shots10 = r10(w.split.t10 * (+so.r10 || 0) * pf);
    const ps = (x, rate) => r5(((w.split.t50 * wt(x)) / pt) * (+rate || 0) * pf);
    w.pos = { k: ps("k", so.rk), p: ps("p", so.rp), s: ps("s", so.rs) };
    w.shots50 = w.pos.k + w.pos.p + w.pos.s;
    w.units = (w.shots10 + w.shots50) * w.inten;
  });
  flags.sort(
    (x, y) =>
      (x.lv === y.lv ? 0 : x.lv === "warn" ? -1 : 1) || (x.w == null ? -1 : x.w) - (y.w == null ? -1 : y.w),
  );
  return { W, blocks, flags, clusters, N, s0, S, hmax, adj: ADJ, evs, wn: a.weekNotes || {} };
}

/* suggestions: changes to this athlete's calendar that would make the plan work better */
function suggest(P, a, cal = st.cal) {
  const out = [],
    seen = new Set(),
    nm = a.name,
    W = P.W,
    isRec = w => w.phase === "REC" || w.phase === "AREC",
    isPrep = w => w.phase === "PP1" || w.phase === "PP2",
    pl = (v, u) => v + " " + u + (v === 1 ? "" : "s");
  const DL = { "10m": "10m", "50m": "50m", both: "10m and 50m" };
  const skip = e => ({ l: `Take it out of ${nm}'s plan`, a: "sg-skip", id: e.id }),
    minor = e => ({ l: "Make it a minor competition", a: "sg-tier", id: e.id, v: "small" }),
    major = e => ({ l: `Make ${e.name} a major`, a: "sg-tier", id: e.id, v: "major" });
  const per = new Map(),
    dense = new Set();
  const add = (e, key, t, why, acts) => {
    if (!per.has(e.id)) per.set(e.id, { e, items: [] });
    const q = per.get(e.id);
    if (!q.items.some(i => i.key === key)) q.items.push({ key, t, why, acts });
  };
  P.clusters.forEach((c, i) => {
    const prev = P.clusters[i - 1];
    if (c.cut && prev) {
      const A = prev.peaks[prev.peaks.length - 1],
        B = c.peaks[0];
      out.push({
        key: "close:" + A.id + ":" + B.id,
        t: `Perhaps ${A.name} and ${B.name} should not both be peaks for ${nm}.`,
        why: `There are only ${pl(c.avail, "week")} between them, so the recovery, the build or the taper has been cut short. As a major, an event still gets a mini-taper, and the other one gets a proper build and taper.`,
        acts: [major(A), major(B)],
      });
    }
    const cl = c.end - c.compStart + 1;
    if (cl > 6 && c.peaks.length > 1)
      out.push({
        key: "long:" + c.peaks.map(p => p.id).join(":"),
        t: `Perhaps one of ${c.peaks.map(p => p.name).join(", ")} could be a major rather than a peak.`,
        why: `Together they keep ${nm} in a competition phase for ${cl} weeks. Peak form is hard to hold beyond about 5 weeks, and no real training happens in that time.`,
        acts: c.peaks.map(major),
      });
  });
  const comps = P.evs
    .filter(e => e.type === "comp" && e.tier !== "peak" && e.tier !== "key" && !e.training)
    .sort((x, y) => x.st - y.st);
  comps.forEach(e => {
    const w = W[e.w0],
      pk = w.next,
      wks = pk ? pk.w0 - e.w0 : null,
      dm = pk && pk.disc !== "both" && e.disc !== "both" && e.disc !== pk.disc,
      both = [skip(e)].concat(e.tier === "major" ? [minor(e)] : []);
    if (isRec(w))
      add(
        e,
        "rec",
        `Maybe ${nm} doesn't have to go to ${e.name}.`,
        `It falls in week ${w.i + 1}, in the recovery period, when the plan has ${nm} off the range or in light active recovery. Competing there carries fatigue into the next build.`,
        both,
      );
    else if (w.phase === "COMP" && w.type !== "Peak competition" && pk) {
      if (dm)
        add(
          e,
          "taperdisc",
          `Maybe ${nm} doesn't have to go to ${e.name}.`,
          `It is a ${DL[e.disc]} match ${pl(wks, "week")} before ${pk.name}, which is ${DL[pk.disc]}. It takes taper time away from the discipline that matters most at that point.`,
          [skip(e)],
        );
      if (wks <= 1 && e.tier === "major")
        add(
          e,
          "taperlate",
          `Perhaps change the focus of ${e.name} to minor, or leave it out.`,
          `It is in the final week before ${pk.name}. As a major it adds travel and competition stress just when the taper should be freshening ${nm} up. As a minor it becomes a low-pressure rehearsal.`,
          [minor(e), skip(e)],
        );
    } else if (isPrep(w) && pk) {
      if (w.type === "Overreach" && e.tier === "major")
        add(
          e,
          "over",
          `Perhaps change the focus of ${e.name} to minor.`,
          `It lands in the heaviest training week before ${pk.name}. As a major it gets a mini-taper, which takes the top off that week. As a minor, ${nm} trains through it and the overreach stays whole.`,
          [minor(e), skip(e)],
        );
      else if (dm && w.phase === "PP2" && wks <= 6)
        add(
          e,
          "disc",
          `Maybe ${e.name} doesn't fit this part of ${nm}'s plan.`,
          `It is a ${DL[e.disc]} match, and the build at that point is aimed at ${pk.name} (${DL[pk.disc]}) ${pl(wks, "week")} later. Preparing for it and shooting it pulls range time away from ${DL[pk.disc]} at the point where the plan wants it concentrated there.`,
          both,
        );
    }
  });
  comps.forEach(e => {
    if (!isPrep(W[e.w0])) return;
    const grp = comps.filter(x => x.w0 >= e.w0 && x.w0 <= e.w0 + 3 && isPrep(W[x.w0]));
    if (grp.length < 3) return;
    if (grp.some(x => dense.has(x.id))) return;
    const c = grp
      .slice()
      .sort(
        (x, y) =>
          (per.has(y.id) ? 1 : 0) - (per.has(x.id) ? 1 : 0) ||
          (x.tier === "small" ? 0 : 1) - (y.tier === "small" ? 0 : 1) ||
          y.st - x.st,
      )[0];
    dense.add(c.id);
    add(
      c,
      "dense",
      `Maybe ${nm} doesn't have to go to ${c.name}.`,
      `${grp.length} competitions fall within 4 weeks of a build phase (${grp.map(x => x.name).join(", ")}). That leaves few uninterrupted training days. ${c.tier === "small" && grp.some(x => x.tier === "major") ? c.name + " is the lowest priority of them." : "Dropping one of them, such as " + c.name + ", would give back a full training week."}`,
      [skip(c)].concat(c.tier === "major" ? [minor(c)] : []),
    );
  });
  P.evs
    .filter(e => e.type === "camp" && isRec(W[e.w0]))
    .forEach(e =>
      add(
        e,
        "camprec",
        `Maybe ${nm} could miss ${e.name}.`,
        `It starts in week ${e.w0 + 1}, in the recovery period. A camp there replaces the rest the next build depends on.`,
        [skip(e)],
      ),
    );
  per.forEach(({ e, items }) => {
    if (items.length === 1) {
      const i = items[0];
      out.push({ key: i.key + ":" + e.id, t: i.t, why: i.why, acts: i.acts });
    } else
      out.unshift({
        key: "multi:" + e.id,
        cls: "strong",
        t: `${e.name} really doesn't fit ${nm}'s plan. Consider leaving it out.`,
        why: items.map(i => i.why).join(" "),
        acts: [skip(e)].concat(e.tier === "major" ? [minor(e)] : []),
      });
  });
  /* good places for a marker competition */
  P.clusters.forEach(c => {
    const pk = c.peaks[0],
      free = w =>
        w.cyc === c.idx &&
        w.type === "Deload" &&
        !w.events.length &&
        !w.hol &&
        !w.manual &&
        !P.evs.some(e => e.type === "comp" && Math.abs(e.w0 - w.i) <= 3);
    const mk = (w, late) => {
      const d = w.target === "both" ? "A 10m or 50m match" : "A " + DL[w.target] + " match",
        pk2 = a.picks || {},
        have = cal.events.filter(
          e =>
            e.type === "comp" &&
            e.start &&
            !(pk2[e.id] && pk2[e.id].on) &&
            parse(e.start) >= w.start &&
            parse(e.start) < w.start + WEEK,
        );
      out.push({
        key: "marker:" + iso(w.start),
        cls: "good",
        t: `There is a good place for a marker competition in week ${w.i + 1} (${range(w.start, w.start + 6 * DAY)}).`,
        why: `It is the lighter week that closes a training block, ${pl(pk.w0 - w.i, "week")} before ${pk.name}, and ${nm} has no other competition within 3 weeks either side. ${nm} would arrive fresh without any change to the loading, and ${late ? "there is still time to act on what it shows before the taper" : "it gives a checkpoint in the middle of a long general preparation"}. ${d} would fit best.${have.length ? "" : " Nothing in the shared calendar starts that week yet."}`,
        acts: have.map(e => ({ l: `Add ${e.name} to ${nm}'s plan`, a: "sg-on", id: e.id })),
      });
    };
    const p2 = W.filter(w => w.phase === "PP2" && free(w) && pk.w0 - w.i >= 4).sort(
      (x, y) => Math.abs(pk.w0 - x.i - 6) - Math.abs(pk.w0 - y.i - 6),
    )[0];
    if (p2) mk(p2, true);
    const p1w = W.filter(w => w.phase === "PP1" && w.cyc === c.idx);
    if (p1w.length >= 8) {
      const mid = p1w[0].i + p1w.length / 2,
        p1 = p1w.filter(free).sort((x, y) => Math.abs(x.i - mid) - Math.abs(y.i - mid))[0];
      if (p1) mk(p1, false);
    }
  });
  const dis = a.dismissed || {};
  return { list: out.filter(x => !dis[x.key]), hidden: out.filter(x => dis[x.key]).length };
}

/* coaching content for a week */
function focus(w, P) {
  const out = [],
    has = t => w.tags.includes(t);
  if (w.hol >= 6) return [`Holiday: no training this week. Proper time away from the range and the gym.`];
  if (w.compDays) {
    const nm = [...new Set(w.events.filter(e => e.type === "comp").map(e => e.name))].join(", ");
    if (w.load === 0 && !w.manual)
      return [
        `Competition: ${nm}. Nothing is planned on competition days. The plan covers the build-up before and the recovery after.`,
      ];
    out.push(
      `Competition days: ${w.compDays} (${nm}). Nothing is planned on them; the hours below are for the other days of the week only.`,
    );
  }
  if (w.hol)
    out.push(
      `Holiday: ${w.hol} day${w.hol === 1 ? "" : "s"} with no training. Hours are for the remaining days only; do not squeeze the missed sessions into them.`,
    );
  if (has("Ease back in"))
    out.push(
      "First week back from holiday: rebuild volume across the week. Start with holding and dry firing before full sessions.",
    );
  if (w.phase !== "REC" && w.phase !== "HOL") {
    const a = Math.round(w.share10 * 100);
    const nx = w.keyEv || w.keyPrep || w.next;
    out.push(
      nx
        ? `Range time about ${a}% 10m, ${100 - a}% 50m. ${nx.w0 > w.i ? nx.w0 - w.i + " week" + (nx.w0 - w.i === 1 ? "" : "s") + " to " + nx.name : nx.name + " this week"}.`
        : `Range time about ${a}% 10m, ${100 - a}% 50m.`,
    );
  }
  const T = {
    Deload: "Deload: cut volume by about a third, keep session quality and frequency.",
    "Peak load": "Heaviest week of this block. Scores may dip; judge it on process, not results.",
    Overreach:
      "Planned overreach: highest load of the year's build. Sleep and nutrition are part of the session plan.",
    "Step-down": "Step down from the overreach. Volume falls, competition-format work stays.",
    Taper: "Taper: volume down, intensity and number of sessions held. Short sessions, full concentration.",
    Maintain: "Between peaks: one or two normal-volume days to top up, then taper again.",
    "Camp load": "Camp replaces the deload. Plan light days straight after.",
    "Key taper":
      "Taper for the key event: volume down, intensity and number of sessions held. Short sessions, full concentration.",
    "Key competition":
      "Key event this week: the full competition routine. Plan two or three easy days after it.",
    "Hold form":
      "Holding form from the previous season before the key event: normal sessions at moderate volume, competition-format work, and no big technical changes.",
    "Easy week":
      "Easy week after the key event: two or three days off the range, then light sessions. The build picks up again next week.",
  };
  if (T[w.type]) out.push(T[w.type]);
  const FT = {
    pp1: "Finals: familiarity work. Commands, timings and single-shot rhythm, with no weight on scores.",
    pp2: "Finals: full finals with announcements, eliminations and noise. They take attention off qualification scores and build resilience.",
    pre: "Finals: a main emphasis of range time this week. Full finals under pressure, including starting from behind and shoot-offs.",
    taper:
      "Finals: short, sharp finals at competition intensity. Rehearse the walk-in, the presentation and the first shots.",
  };
  if (w.finKind && w.split.fin >= 0.25) out.push(FT[w.finKind]);
  if (w.techFocus) out.push("Technical emphasis from the log: isolated elements, dry firing and holding; judge sessions on process.");
  if (w.finBoost) out.push("Transfer from the log: competition simulations, full finals and match routines under some pressure.");
  if ((w.avoid || []).length || (w.reduce || []).length) out.push("Health from the log: adjust sessions around the affected positions and check with the medical team before loading them again.");
  if (w.manual)
    out.push("This week has been adjusted by hand, so its figures differ from the automatic plan.");
  if (has("Key event"))
    out.push(
      "Key event inside the build: volume well down, the full competition routine, and no experiments with technique or equipment.",
    );
  if (has("Short taper"))
    out.push("Short taper for the key event next week: volume down about a fifth, intensity up, match and finals rehearsals.");
  if (has("Easy days first"))
    out.push("Start the week with one or two easy days after the key event, then return to the block.");
  if (has("Mini-taper"))
    out.push(
      `Mini-taper: reduce volume for the ${P.S.majorTaperDays} days before the major competition and run the full peak-event routine.`,
    );
  if (has("Train through"))
    out.push(
      "Minor competition: train through it. Use it as a competition simulation with process goals only.",
    );
  if (has("Rehearsal"))
    out.push("Major competition as final rehearsal: same warm-up, timings and match plan as the peak event.");
  if (has("Camp") && w.type !== "Camp load")
    out.push(
      w.phase === "COMP"
        ? "Pre-competition camp: taper volume, match rehearsals, finals practice."
        : "Training camp: use the extra range time for the block's technical priorities.",
    );
  const F = {
    PP1: [
      "Technique: isolated elements. Dry firing, holding, position rebuilds for kneeling, prone and standing taken one at a time.",
      "Physical: main strength and aerobic gains of the cycle. Stabilisers and trunk first.",
      "Mental: relaxation training, goal setting, motivation.",
      "Equipment and ammunition tests, performance tests and a SCATT baseline belong here.",
    ],
    PP2: [
      "Technique: rhythm and flow. Full 3-position courses with changeovers and sighter timing; full 60-shot air rifle matches.",
      "Physical: maintain, small gains only.",
      "Mental: concentration, stop techniques, visualisation; write and rehearse the match script.",
      "Tactics: time management, if-then rules, wind and light reading at 50m. Lock equipment choices; nothing new after this phase.",
    ],
    COMP: [
      "Short, technically intense sessions. Competition simulations, finals, competition warm-ups.",
      "Physical: light aerobic work as active recovery only.",
      "Mental: competition visualisation, routines, regular sleep and food.",
      "No new equipment or technique changes.",
    ],
    REC: [
      "No range access. Holiday, leisure, wellness.",
      "Leave the competition analysis until emotions have settled.",
    ],
    HOL: ["Holiday: no range or gym sessions are planned."],
    AREC: [
      "Fun recreational sport and light extensive training.",
      "Complete the competition analysis (body, technique, tactics, mental, environment) and set goals for the next cycle.",
    ],
  };
  return out.concat(F[w.phase]);
}
