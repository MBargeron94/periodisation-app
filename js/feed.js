"use strict";
/* ===== rankings feed: read-only copy of rifle-feed.json, written to the `feed` collection by Claude on request ===== */
const ZC = { 50: 0, 70: 0.524, 85: 1.036 },
  EVLAB = { AR10: "10m Air Rifle", "3P": "50m 3 Positions", PR: "50m Prone" };
const dmp = h => 1.5 * (1 - Math.exp(-h / 1.5));
/* standard normal CDF (Abramowitz and Stegun 7.1.26, error under 1e-7) */
const Phi = x => {
  const u = Math.abs(x) / Math.SQRT2,
    t = 1 / (1 + 0.3275911 * u),
    y =
      1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
        t *
        Math.exp(-u * u);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
};
const mS = ms => {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  },
  mAdd = (ms, n) => {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
  };
const mDiff = (a, b) => {
  const x = new Date(a),
    y = new Date(b);
  return (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + y.getUTCMonth() - x.getUTCMonth();
};
const mLab = ms => fmt(ms, { day: undefined, month: "short", year: "numeric" });
const avg = v => (v.length ? v.reduce((t, x) => t + x, 0) / v.length : null),
  f1 = x => (x == null ? "—" : (Math.round(x * 10) / 10).toFixed(1)),
  pc = x => Math.round(x * 100) + "%";
function assembleFeed(docs) {
  const m = docs.find(d => d.id === "meta");
  if (!m) return null;
  const M = m.data,
    F = { meta: M, events: {} };
  (M.chunks || []).forEach(cid => {
    const d = docs.find(x => x.id === cid);
    if (!d) return;
    const x = d.data,
      E = (F.events[x.event] = F.events[x.event] || { athletes: [] });
    if (x.head) Object.assign(E, x.head);
    E.athletes = E.athletes.concat(x.athletes || []);
  });
  Object.values(F.events).forEach(E => {
    E.byId = {};
    E.athletes.forEach(a => {
      E.byId[a.id] = a;
    });
    E.bench = {};
    (E.benchmarks || []).forEach(b => {
      E.bench[b.compId] = b;
    });
  });
  return F;
}
const genderOf = id => (/^SH[A-Z]{3}[MW]\d{10}$/.test(id || "") ? id[5] : null);
/* the athlete's feed entries, one per event they appear in */
function feedEntries(a, F = st.feed) {
  const g = genderOf(a.issfId);
  if (!F || !g) return [];
  return ["AR10", "3P", "PR"]
    .map(k => {
      const key = k + "_" + g,
        E = F.events[key],
        fa = E && E.byId[a.issfId];
      return fa ? { key, k, E, fa } : null;
    })
    .filter(Boolean);
}
/* one goal, worked out with the formulas in the feed README */
function goalCalc(a, g, F = st.feed) {
  if (!F) return { err: "The rankings feed is not loaded." };
  const E = F.events[g.ev];
  if (!E) return { err: "This event is not in the feed." };
  const b = E.bench[g.compId];
  if (!b) return { err: "This competition is no longer in the feed's upcoming competitions." };
  const fa = a.issfId && E.byId[a.issfId];
  if (!fa) return { b, E, err: `${a.name} has no entry for ${E.label} in the feed.` };
  const z = ZC[g.conf] != null ? ZC[g.conf] : ZC[70],
    s8 = Math.hypot(fa.sd, b.sd8),
    s3 = Math.hypot(fa.sd, b.sd3),
    prone = g.ev.startsWith("PR");
  const proj = fa.meanNow + fa.slope * dmp(b.hz) + b.vOff8,
    pF = Phi((proj - b.cut8) / s8),
    pM = prone ? Phi((proj - b.cut3) / s3) : pF * fa.conv;
  const needF = b.cut8 + z * s8,
    needM = b.cut3 + z * s3,
    need = g.out === "medal" ? needM : needF;
  const gen = parse(String(F.meta.generated).slice(0, 10)),
    t0 = g.start ? parse(g.start) : gen;
  const L0 = t0 > gen ? fa.meanNow + fa.slope * dmp((t0 - gen) / (365.25 * DAY)) : fa.meanNow,
    Lend = need - b.vOff8;
  const tgt = parse(b.start),
    m0 = mS(t0),
    mEnd = mAdd(mS(tgt), -1),
    K = Math.max(0, mDiff(m0, mEnd)),
    months = [];
  for (let i = 0; i <= K; i++) months.push({ m: mAdd(m0, i), mil: K ? L0 + ((Lend - L0) * i) / K : Lend });
  months.push({ m: mS(tgt), mil: null, target: true });
  const tr = (a.training || []).filter(x => x.ev === g.ev);
  months.forEach(M => {
    const me = mAdd(M.m, 1) - 1,
      inM = d => {
        const t = parse(d);
        return t >= M.m && t <= me;
      },
      sc = (fa.scores || []).filter(x => inM(x.d));
    M.sc = sc;
    M.raw = avg(sc.map(x => +x.s));
    M.adj = avg(sc.map(x => +x.v));
    M.comps = (E.benchmarks || []).filter(x => inM(x.start));
    M.tr = tr.filter(x => inM(x.date));
    M.trAvg = avg(M.tr.filter(x => +x.score > 0).map(x => +x.score));
    M.status =
      M.mil != null && M.adj != null
        ? M.adj >= M.mil
          ? "on"
          : M.adj >= M.mil - 0.5 * fa.sd
            ? "close"
            : "behind"
        : null;
  });
  return { b, E, fa, z, s8, s3, proj, pF, pM, needF, needM, need, L0, Lend, months, prone };
}
/* the athlete's ISSF qualification scores for one planner competition: same dates (one day either side),
   and either linked to an ISSF competition or named after the city the score was shot in */
function feedScore(a, e, F = st.feed) {
  const out = {},
    g = genderOf(a.issfId);
  if (!F || !g || e.type !== "comp" || e.training) return out;
  const ks = e.disc === "10m" ? ["AR10"] : e.disc === "50m" ? ["3P"] : ["AR10", "3P"],
    nm = e.name.toLowerCase();
  ks.forEach(k => {
    const E = F.events[k + "_" + g],
      fa = E && E.byId[a.issfId];
    if (!fa) return;
    const hit = (fa.scores || [])
      .filter(x => {
        const t = parse(x.d),
          city = String(x.c)
            .replace(/\s*\d{4}$/, "")
            .toLowerCase()
            .slice(0, 4);
        return t >= e.st - DAY && t <= e.en + DAY && (e.feedComp || (city && nm.includes(city)));
      })
      .pop();
    if (hit) out[k === "AR10" ? "q10" : "q50"] = { s: +hit.s, c: hit.c, p: hit.p };
  });
  return out;
}
/* days since the feed was generated; the feed is rebuilt monthly */
function feedAge(F = st.feed) {
  return F ? Math.floor((Date.now() - parse(String(F.meta.generated).slice(0, 10))) / DAY) : null;
}
function feedWarn() {
  const d = feedAge();
  return d != null && d > 35
    ? `<p class="banner" style="margin:6px 0 0">The rankings feed copy is ${d} days old and the feed is rebuilt monthly, so a newer one is probably available. Ask Claude to refresh it.</p>`
    : "";
}
const fgList = a => (a.fgoals || {})[a.seasonStart] || [];
function mainGoal(a, F = st.feed) {
  const L = fgList(a);
  if (!L.length || !F) return null;
  const g = L.find(x => x.id === a.fgMain) || L[0],
    c = goalCalc(a, g, F);
  return c.err || !c.months ? null : Object.assign({ g }, c);
}
const STL = { on: "On track", close: "Close", behind: "Behind" },
  stCls = { on: "ok", close: "stretch", behind: "bad" };
function monthOf(P, ms) {
  return P && P.fg ? P.fg.months.find(M => M.m === mS(ms)) : null;
}
function pathLine(M, fg) {
  return M.target
    ? `Target month: ${esc(fg.b.comp)}, level needed ${f1(fg.need)} at the venue (${f1(fg.Lend)} venue-adjusted)`
    : `Milestone <strong>${f1(M.mil)}</strong> · competitions ${M.adj != null ? `${f1(M.raw)} raw / ${f1(M.adj)} adjusted (${M.sc.length})` : "none"}${M.trAvg != null ? ` · training ${f1(M.trAvg)} (${M.tr.filter(x => +x.score > 0).length})` : ""}${M.status ? ` <span class="pill rate-${stCls[M.status]}">${STL[M.status]}</span>` : ""}`;
}
