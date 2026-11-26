"use strict";
/* ================= state and storage ================= */
function lsGet0(k) {
  try {
    return localStorage.getItem(k);
  } catch (e) {
    return null;
  }
}
const st = {
  feed: null,
  checksOpen: (v => (v == null ? null : v === "1"))(lsGet0("rsp-checks")),
  dl: null,
  sample: null,
  review: null,
  restore: null,
  bkMsg: "",
  view: "athlete",
  zoom: +lsGet0("rsp-zoom") || 1,
  jump: false,
  athletes: {},
  cal: { events: [] },
  cur: null,
  sel: null,
  editing: null,
  confirmDel: null,
  wk: null,
  ses: null,
  wkAsk: null,
  copyFrom: "",
  adding: false,
  mode: "loading",
  /* who is viewing: "coach" (the page owner, or browser-only mode), "athlete" (sees only their own linked plan),
     "locked" (shared the page but no plan linked to them yet) */
  role: "coach",
  user: null,
  me: null,
  names: {},
  claims: [],
  claimMsg: "",
  privNotes: {},
  pend: {},
  inflight: {},
  needRender: false,
};
let db = null,
  chain = Promise.resolve(),
  timers = {};
const lsGet = k => {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  },
  lsSet = (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch (e) {}
  };
const uid = () => Math.random().toString(36).slice(2, 10);
const cur = () => st.athletes[st.cur] || null;
function setSave(t) {
  const el = document.getElementById("save");
  if (el) el.textContent = t;
}
function persist(id) {
  if (st.mode === "local") {
    lsSet("rsp-athletes", JSON.stringify(st.athletes));
    lsSet("rsp-calendar", JSON.stringify(st.cal));
    setSave("Saved in this browser only");
    return;
  }
  clearTimeout(timers[id]);
  setSave("Saving…");
  st.pend[id] = true;
  timers[id] = setTimeout(() => {
    st.pend[id] = false;
    st.inflight[id] = (st.inflight[id] || 0) + 1;
    chain = chain
      .then(() => writeAthlete(id, st.athletes[id]))
      .then(
        () => setSave("Saved"),
        e => setSave("Could not save: " + ((e && e.message) || "storage refused the change")),
      )
      .then(() => {
        st.inflight[id]--;
      });
  }, 500);
}
/* the coach's notes on an athlete live in private/<id>, which only the page owner can read;
   everything else lives in athletes/<id>, which a linked athlete can read too */
async function writeAthlete(id, doc) {
  if (!doc) {
    await db.doc("athletes/" + id).delete();
    if (st.role === "coach") await db.doc("private/" + id).delete();
    return;
  }
  const pub = JSON.parse(JSON.stringify(doc)),
    notes = pub.notes || "";
  delete pub.notes;
  if (st.role === "coach" && notes !== (st.privNotes[id] || "")) {
    await db.doc("private/" + id).set({ notes });
    st.privNotes[id] = notes;
  }
  await db.doc("athletes/" + id).set(pub);
}
/* key-order-independent comparison, so a copy that comes back from the database is not mistaken for a change */
const stable = v =>
  Array.isArray(v)
    ? "[" + v.map(stable).join(",") + "]"
    : v && typeof v === "object"
      ? "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}"
      : JSON.stringify(v);
/* re-render after a change from elsewhere, but never while someone is typing */
function remoteRender() {
  const ae = document.activeElement;
  if (ae && ae.matches && ae.matches("input,textarea,select")) {
    st.needRender = true;
    return;
  }
  render();
}
document.addEventListener("focusout", () =>
  setTimeout(() => {
    const ae = document.activeElement;
    if (st.needRender && !(ae && ae.matches && ae.matches("input,textarea,select"))) {
      st.needRender = false;
      render();
    }
  }, 0),
);
/* live copies: the coach and an athlete can have the same plan open at once */
function startSync() {
  if (!db) return;
  const cp = o => JSON.parse(JSON.stringify(o));
  db.collection("athletes").onSnapshot(
    snap => {
      let ch = false;
      const seen = new Set(),
        busy = id => st.pend[id] || st.inflight[id] > 0;
      snap.docs.forEach(d => {
        seen.add(d.id);
        if (busy(d.id)) return;
        const nd = cp(d.data()),
          old = st.athletes[d.id];
        if (st.role === "coach" && old && old.notes != null && nd.notes == null) nd.notes = old.notes;
        if (!old || stable(old) !== stable(nd)) {
          st.athletes[d.id] = nd;
          ch = true;
        }
      });
      Object.keys(st.athletes).forEach(id => {
        if (!seen.has(id) && !busy(id)) {
          delete st.athletes[id];
          ch = true;
        }
      });
      if (!ch) return;
      if (st.role !== "coach") {
        const mine = Object.keys(st.athletes)[0] || null;
        st.role = mine ? "athlete" : "locked";
        if (st.cur !== mine) {
          st.cur = mine;
          st.sel = null;
          st.wk = st.ses = null;
        }
      } else if (!st.athletes[st.cur]) st.cur = Object.keys(st.athletes)[0] || null;
      remoteRender();
    },
    () => {},
  );
  db.doc("shared/calendar").onSnapshot(
    d => {
      if (st.pend.__cal || st.inflight.__cal > 0) return;
      const c = d.exists ? cp(d.data()) : { events: [] };
      if (!Array.isArray(c.events) || stable(c) === stable(st.cal)) return;
      st.cal = c;
      remoteRender();
    },
    () => {},
  );
  if (st.role === "coach")
    db.collection("claims").onSnapshot(
      snap => {
        st.claims = snap.docs.map(d => ({ id: d.id, code: String((d.data() || {}).code || "").toUpperCase().trim() }));
        processClaims();
      },
      () => {},
    );
}
/* ---------- linking an athlete's plan to their account ---------- */
/* letters only, so any phone keyboard works; no I or O, which look like 1 and 0 */
const CODE_CH = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const newCode = () =>
  Array.from(crypto.getRandomValues(new Uint32Array(6)), n => CODE_CH[n % CODE_CH.length]).join("");
const isLinked = id => /^u_/.test(id || "");
/* an athlete typed a code in their own view: match it to the athlete it was made for and move that plan to their account */
function processClaims() {
  let ch = false;
  st.claims.forEach(c => {
    if (c.done) return;
    const aid = Object.keys(st.athletes).find(k => !isLinked(k) && st.athletes[k].claim && st.athletes[k].claim === c.code);
    if (!aid || st.athletes[c.id]) return;
    c.done = true;
    moveAthlete(aid, c.id, true);
    chain = chain.then(() => db.doc("claims/" + c.id).delete()).catch(() => {});
    ch = true;
  });
  st.claims = st.claims.filter(c => !c.done);
  remoteRender();
  return ch;
}
/* move a plan to another record id: linking (to the athlete's account id) or unlinking (to a fresh id) */
function moveAthlete(from, to, linking) {
  const a = st.athletes[from];
  if (!a || st.athletes[to]) return;
  const na = Object.assign({}, a);
  delete na.claim;
  st.pend[from] = st.pend[to] = true;
  st.athletes[to] = na;
  delete st.athletes[from];
  st.privNotes[to] = undefined;
  if (st.cur === from) {
    st.cur = to;
    lsSet("rsp-cur", to);
  }
  setSave("Saving…");
  chain = chain
    .then(async () => {
      await writeAthlete(to, na);
      await db.doc("athletes/" + from).delete();
      await db.doc("private/" + from).delete();
      delete st.privNotes[from];
    })
    .then(
      () => setSave(linking ? `${na.name}'s plan is now linked to their account` : "Saved"),
      e => setSave("Could not save: " + ((e && e.message) || "storage refused the change")),
    )
    .then(() => {
      st.pend[from] = st.pend[to] = false;
    });
}
function saveCal() {
  if (st.mode === "local") {
    lsSet("rsp-calendar", JSON.stringify(st.cal));
    setSave("Saved in this browser only");
    return;
  }
  if (st.role !== "coach") return;
  clearTimeout(timers.__cal);
  setSave("Saving…");
  st.pend.__cal = true;
  timers.__cal = setTimeout(() => {
    st.pend.__cal = false;
    st.inflight.__cal = (st.inflight.__cal || 0) + 1;
    chain = chain
      .then(() => db.doc("shared/calendar").set(JSON.parse(JSON.stringify(st.cal))))
      .then(
        () => setSave("Saved"),
        e => setSave("Could not save: " + ((e && e.message) || "storage refused the change")),
      )
      .then(() => {
        st.inflight.__cal--;
      });
  }, 500);
}
/* an athlete's plan = the shared calendar, filtered by what is switched on for them, with their own priority and taper */
function view(a) {
  const pk = a.picks || {};
  return Object.assign({}, a, {
    events: st.cal.events
      .filter(e => pk[e.id] && pk[e.id].on)
      .map(e =>
        Object.assign(
          {},
          e,
          e.type === "comp"
            ? {
                tier: e.training ? "small" : pk[e.id].tier || e.tier,
                taper: pk[e.id].taper,
              }
            : {},
        ),
      ),
  });
}
/* older plans kept events inside each athlete: move them into the shared calendar once */
function migrate() {
  let calCh = false;
  if (!st.cal || !Array.isArray(st.cal.events)) st.cal = { events: [] };
  Object.keys(st.athletes).forEach(k => {
    const a = st.athletes[k];
    if (!Array.isArray(a.events)) return;
    a.picks = a.picks || {};
    a.events.forEach(e => {
      let c = st.cal.events.find(
        x =>
          x.name === e.name &&
          x.start === e.start &&
          (x.end || x.start) === (e.end || e.start) &&
          x.type === e.type &&
          x.disc === e.disc,
      );
      if (!c) {
        c = {
          id: st.cal.events.some(x => x.id === e.id) || !e.id ? uid() : e.id,
          name: e.name,
          type: e.type,
          start: e.start,
          end: e.end || e.start,
          disc: e.disc,
          tier: e.tier || null,
        };
        st.cal.events.push(c);
        calCh = true;
      }
      const pk = { on: true };
      if (e.type === "comp" && e.tier && e.tier !== c.tier) pk.tier = e.tier;
      if (e.taper) pk.taper = e.taper;
      a.picks[c.id] = pk;
    });
    delete a.events;
    persist(k);
  });
  if (calCh) saveCal();
}
function mutate(fn) {
  const a = cur();
  if (!a) return;
  fn(a);
  persist(st.cur);
  render();
}
function newAthlete(name, from) {
  const id = uid();
  st.athletes[id] = from
    ? Object.assign(JSON.parse(JSON.stringify(from)), { name })
    : { name, seasonStart: iso(mondayOf(Date.now())), weeks: 52, hoursMax: 30, picks: {}, settings: {} };
  st.cur = id;
  st.sel = null;
  st.adding = false;
  lsSet("rsp-cur", id);
  persist(id);
  render();
}
async function boot() {
  const finish = mode => {
    if (st.mode !== "loading") return;
    st.mode = mode;
    if (mode === "local") {
      try {
        st.athletes = JSON.parse(lsGet("rsp-athletes") || "{}") || {};
      } catch (e) {
        st.athletes = {};
      }
      try {
        st.cal = JSON.parse(lsGet("rsp-calendar") || "null") || { events: [] };
      } catch (e) {
        st.cal = { events: [] };
      }
    }
    try {
      migrate();
    } catch (e) {
      $("notice").textContent = "Older plans could not be moved into the shared calendar: " + e.message;
    }
    const want = lsGet("rsp-cur");
    st.cur = st.athletes[want] ? want : Object.keys(st.athletes)[0] || null;
    if (st.role !== "coach") st.view = "athlete";
    render();
  };
  if (!(window.claude && window.claude.use)) return finish("local");
  const t = setTimeout(() => finish("local"), 10000),
    uP = window.claude.use("user").catch(() => null);
  try {
    db = await window.claude.use("db");
    if (!db) {
      clearTimeout(t);
      return finish("local");
    }
    const snap = await db.collection("athletes").get(),
      cd = await db.doc("shared/calendar").get();
    let fd = null;
    try {
      fd = await db.collection("feed").get();
    } catch (e) {
      fd = null;
    }
    clearTimeout(t);
    if (st.mode !== "loading") {
      db = null;
      return;
    }
    const cp = o => JSON.parse(JSON.stringify(o));
    snap.docs.forEach(d => {
      st.athletes[d.id] = cp(d.data());
    });
    if (cd.exists) st.cal = cp(cd.data());
    if (fd) st.feed = assembleFeed(fd.docs.map(d => ({ id: d.id, data: cp(d.data()) })));
    /* who is this? The owner is the coach. Anyone else only ever reads their own linked plan (access rules). */
    const u = await Promise.race([uP, new Promise(r => setTimeout(() => r(null), 8000))]);
    st.user = u;
    st.me = u ? await u.id().catch(() => null) : null;
    /* isOwner() answers asynchronously; anything other than a clear yes is not the owner */
    const owner = u ? (await Promise.resolve(u.isOwner()).catch(() => false)) === true : snap.docs.length > 1;
    st.role = owner ? "coach" : snap.docs.length ? "athlete" : "locked";
    if (st.role === "coach") {
      /* coach's private notes; notes still kept in an athlete record move to the private record */
      let pv = null;
      try {
        pv = await db.collection("private").get();
      } catch (e) {
        pv = null;
      }
      if (pv)
        pv.docs.forEach(d => {
          const n = (d.data() || {}).notes || "";
          st.privNotes[d.id] = n;
          if (st.athletes[d.id] && !st.athletes[d.id].notes) st.athletes[d.id].notes = n;
        });
    }
    finish("db");
    if (st.role === "coach")
      snap.docs.forEach(d => {
        if ("notes" in (d.data() || {})) persist(d.id);
      });
    startSync();
    window.claude.use("sample").then(
      d => {
        st.sample = d;
        render();
      },
      () => {},
    );
    window.claude.use("downloads").then(
      d => {
        st.dl = d;
        render();
      },
      () => {},
    );
  } catch (e) {
    clearTimeout(t);
    db = null;
    finish("local");
  }
}

/* ================= rendering ================= */
const $ = id => document.getElementById(id);
const hrs = v => (Math.round(v * 2) / 2).toFixed(1).replace(".0", "");
const discLab = { "10m": "10m", "50m": "50m 3P", both: "10m + 50m" },
  tierLab = { small: "Minor", major: "Major", key: "Key", peak: "Peak" };
function render() {
  if (st.role === "locked") {
    $("notice").innerHTML = "";
    $("athbar").innerHTML = "";
    $("app").innerHTML = `<div class="panel empty"><h2>Your plan is not linked yet</h2>${
      st.me
        ? `<p>Your coach gives you a 6-letter link code. Enter it here once. Your plan then appears on this page, usually within a few seconds; your coach's planner needs to be open somewhere for the link to complete. You only ever see your own plan.</p>
      <form id="claim-form" class="row" style="justify-content:center"><label class="f">Link code<input id="claim-code" type="text" inputmode="text" maxlength="6" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="go" style="width:110px;text-transform:uppercase;letter-spacing:.12em" required></label><button class="pri" type="submit">Link my plan</button></form>
      ${st.claimMsg ? `<p role="status" style="margin-top:10px">${esc(st.claimMsg)}</p>` : ""}`
        : `<p>Your account could not be identified in this view. Open the planner in the Claude app or on claude.ai while signed in.</p>`
    }</div>`;
    return;
  }
  if (st.role === "athlete") {
    renderAthlete();
    return;
  }
  const ids = Object.keys(st.athletes).sort((x, y) => st.athletes[x].name.localeCompare(st.athletes[y].name)),
    a = cur();
  const badClaims = st.role === "coach" ? st.claims.filter(c => !c.done) : [];
  $("notice").innerHTML =
    (badClaims.length
      ? `<div class="banner">${badClaims.map(c => `Someone entered the link code <strong>${esc(c.code)}</strong>, which does not match any athlete's current code${Object.keys(st.athletes).includes(c.id) ? " (their account is already linked to a plan)" : ""}. <button class="link" data-act="claim-del" data-id="${esc(c.id)}">Remove</button>`).join("<br>")}</div>`
      : "") +
    (st.mode === "local"
      ? `<div class="banner">Plans are being kept in this browser only, because account storage is not available in this view. They will not appear on another device.</div>`
      : "");
  $("athbar").innerHTML =
    st.mode === "loading"
      ? ""
      : (ids.length
          ? `<label class="f">Athlete<select id="ath-sel">${ids.map(i => `<option value="${i}"${i === st.cur ? " selected" : ""}>${esc(st.athletes[i].name)}</option>`).join("")}</select></label>`
          : "") +
        (st.adding
          ? `<label class="f">New athlete name<input id="ath-new" maxlength="60"></label><button class="pri" data-act="ath-create">Create</button>${a ? `<button data-act="ath-dup">Copy current plan</button>` : ""}<button data-act="ath-cancel">Cancel</button>`
          : `<button data-act="ath-add">Add athlete</button>`) +
        (ids.length
          ? `<div class="seg" role="group" aria-label="View">${[
              ["athlete", "Athlete plan"],
              ["month", "Month calendar"],
              ["squad", "Squad overview"],
            ]
              .map(
                v =>
                  `<button data-act="view" data-id="${v[0]}" class="${st.view === v[0] ? "on" : ""}" aria-pressed="${st.view === v[0]}">${v[1]}</button>`,
              )
              .join("")}</div>`
          : "") +
        `<span id="save">${st.mode === "local" ? "Saved in this browser only" : "Saved"}</span>`;
  if (st.mode === "loading") return;
  if (!a) {
    $("app").innerHTML =
      `<div class="panel empty"><h2>No athletes yet</h2><p>Add an athlete, enter their competitions and camps, and the season is periodised backwards from the peak events: preparation phases, tapers, recovery blocks and a 4-week loading plan.</p>${st.adding ? "" : `<button class="pri" data-act="ath-add">Add your first athlete</button>`}</div>`;
    return;
  }
  if (st.view === "squad") {
    $("app").innerHTML = `<div class="wrap">${squadHtml(ids)}${backupHtml()}</div>`;
    if (st.adding) {
      const n = $("ath-new");
      n && n.focus();
    }
    return;
  }
  const P = plan(view(a));
  P.fg = mainGoal(a);
  if (st.sel == null || st.sel >= P.blocks.length) {
    const now = Math.floor((Date.now() - P.s0) / WEEK);
    st.sel = now >= 0 && now < P.N ? P.W[now].block : 0;
  }
  if (st.view === "month") {
    $("app").innerHTML = `<div class="wrap">${monthHtml(a, P)}</div>`;
    if (st.adding) {
      const n = $("ath-new");
      n && n.focus();
    }
    return;
  }
  const oldTl = $("tl"),
    keep = oldTl ? oldTl.parentElement.scrollLeft : 0;
  $("app").innerHTML =
    `<div class="wrap">${profileHtml(a)}${accessHtml(a)}${yearHtml(a, P)}${flagsHtml(P)}${suggestHtml(P, a)}${blockHtml(P)}${feedGoalsHtml(a, P)}<div class="grid2">${eventsHtml(a)}${settingsHtml(P)}</div><div class="grid2">${notesHtml(a)}${resultsHtml(a, P)}</div>${methodHtml()}${backupHtml()}</div>`;
  if (st.adding) {
    const n = $("ath-new");
    n && n.focus();
  }
  const tl = $("tl");
  if (tl) {
    const sc = tl.parentElement,
      cw = +tl.dataset.cw,
      lw = +tl.dataset.lw,
      b = P.blocks[st.sel];
    sc.scrollLeft = keep;
    if (st.jump) {
      const x0 = b.start * cw,
        x1 = (b.start + b.len) * cw,
        vis = sc.clientWidth - lw;
      if (x0 < sc.scrollLeft || x1 > sc.scrollLeft + vis) sc.scrollLeft = Math.max(0, x0 - cw);
    }
  }
  st.jump = false;
  syncEvForm();
}
/* ---------- athlete access (coach side) ---------- */
function nameOf(id) {
  if (st.names[id] == null && st.user && st.user.profiles) {
    st.names[id] = "";
    st.user.profiles([id]).then(
      ps => {
        const n = (ps[id] && ps[id].name) || "";
        if (n) {
          st.names[id] = n;
          remoteRender();
        }
      },
      () => {},
    );
  }
  return st.names[id] || "";
}
function accessHtml(a) {
  if (st.mode !== "db" || st.role !== "coach") return "";
  const id = st.cur;
  if (isLinked(id)) {
    const n = nameOf(id);
    return `<section class="panel acc"><div class="hd"><h2>Athlete access</h2><span class="pill rate-ok">Linked</span></div>
    <p style="margin:0">This plan is linked to ${n ? `<strong>${esc(n)}</strong>'s account` : "an athlete's account"}. When they open the planner they see only this plan. They can switch competitions on or off and change their priority and taper, plan their weekly sessions and fill in the weekly log. Everything else, including your notes, stays with you.</p>
    <div class="row" style="margin-top:8px">${st.confirmDel === "unlink" ? `<button class="danger" data-act="acc-unlink2">Unlink: they lose access to this plan</button><button data-act="del-cancel">Keep</button>` : `<button class="link" data-act="acc-unlink">Unlink this account</button>`}</div></section>`;
  }
  return `<section class="panel acc"><div class="hd"><h2>Athlete access</h2><span class="muted">Not linked</span></div>
  ${
    a.claim
      ? `<p style="margin:0 0 6px">Link code for ${esc(a.name)}: <strong class="code">${esc(a.claim)}</strong></p>
    <ol class="steps"><li>In the Share menu, invite ${esc(a.name)} by email as <strong>Editor</strong>. Keep "anyone with the link" off: with it on, invited people can only view.</li><li>Give them this code. When they open the planner they are asked for it once.</li><li>Their plan links to their account the next time this planner is open, usually straight away. This code then stops working.</li></ol>
    <div class="row" style="margin-top:6px"><button data-act="acc-code">Make a new code</button><button class="link" data-act="acc-nocode">Cancel the code</button></div>`
      : `<p style="margin:0 0 8px">Let ${esc(a.name)} open this plan in their own Claude app. They will see only their own plan, and can change only their competitions, weekly sessions and weekly log.</p><button data-act="acc-code">Create a link code</button>`
  }</section>`;
}
/* ---------- the athlete's own view ---------- */
function renderAthlete() {
  const a = cur();
  if (!a) return;
  if (st.view === "squad") st.view = "athlete";
  $("notice").innerHTML = "";
  $("athbar").innerHTML =
    `<div class="seg" role="group" aria-label="View">${[
      ["athlete", "My plan"],
      ["month", "Month calendar"],
    ]
      .map(v => `<button data-act="view" data-id="${v[0]}" class="${st.view === v[0] ? "on" : ""}" aria-pressed="${st.view === v[0]}">${v[1]}</button>`)
      .join("")}</div><span id="save">Saved</span>`;
  const P = plan(view(a));
  P.fg = null;
  if (st.sel == null || st.sel >= P.blocks.length) {
    const now = Math.floor((Date.now() - P.s0) / WEEK);
    st.sel = now >= 0 && now < P.N ? P.W[now].block : 0;
  }
  const head = `<section class="panel"><div class="lab">Season ${esc(seasonLab({ start: a.seasonStart, weeks: a.weeks || 52 }))}</div><h2>${esc(a.name)}</h2>
    <p class="muted" style="margin:6px 0 0;font-size:12.5px">This is your plan from your coach. You can switch competitions on or off and change their priority, plan your weekly sessions (Plan sessions on a week card) and fill in your weekly log. Your coach sees every change.</p></section>`;
  if (st.view === "month") {
    $("app").innerHTML = `<div class="wrap">${head}${monthHtml(a, P)}</div>`;
    return;
  }
  const oldTl = $("tl"),
    keep = oldTl ? oldTl.parentElement.scrollLeft : 0;
  $("app").innerHTML = `<div class="wrap">${head}${yearHtml(a, P)}${flagsHtml(P)}${blockHtml(P)}${eventsHtml(a)}${methodHtml()}</div>`;
  const tl = $("tl");
  if (tl) {
    const sc = tl.parentElement,
      cw = +tl.dataset.cw,
      lw = +tl.dataset.lw,
      b = P.blocks[st.sel];
    sc.scrollLeft = keep;
    if (st.jump) {
      const x0 = b.start * cw,
        x1 = (b.start + b.len) * cw,
        vis = sc.clientWidth - lw;
      if (x0 < sc.scrollLeft || x1 > sc.scrollLeft + vis) sc.scrollLeft = Math.max(0, x0 - cw);
    }
  }
  st.jump = false;
}
/* what an athlete may do on the page; everything else is the coach's */
const ATH_ACTS = new Set(["view", "blk-prev", "blk-next", "zoom", "del-cancel"]);
const athAllowed = act => ATH_ACTS.has(act) || act.startsWith("wk-") || act.startsWith("ses-");
function seasonsOf(a) {
  const l = (a.seasons || [])
    .filter(x => x && x.start && x.start !== a.seasonStart)
    .map(x => ({ start: x.start, weeks: x.weeks || 52 }));
  l.push({ start: a.seasonStart, weeks: a.weeks || 52 });
  return l.sort((x, y) => parse(x.start) - parse(y.start));
}
const seasonLab = x => {
  const a0 = mondayOf(parse(x.start));
  return fmt(a0, { year: "numeric" }) + " – " + fmt(a0 + x.weeks * WEEK - DAY, { year: "numeric" });
};
function profileHtml(a) {
  const ss = seasonsOf(a),
    age = a.birthYear ? new Date().getUTCFullYear() - a.birthYear : null,
    o = (v, l) => `<option value="${v}"${(a.strength || "even") === v ? " selected" : ""}>${l}</option>`;
  return `<section class="panel"><div class="row">
  <label class="f">Athlete name<input id="p-name" data-p="name" value="${esc(a.name)}" maxlength="60"></label>
  <label class="f">ISSF ID<input id="p-issf" data-p="issfId" maxlength="20" style="width:170px" placeholder="e.g. SHSUIW0101200001" value="${esc(a.issfId || "")}"></label>
  <label class="f">Birth year<input id="p-by" type="number" min="1940" max="2020" data-p="birthYear" placeholder="Year" value="${esc(a.birthYear || "")}"></label>
  <label class="f">Stronger discipline<select id="p-str" data-p="strength">${o("even", "Balanced")}${o("10m", "10m")}${o("50m", "50m 3P")}</select></label>
  <label class="f">Season<select id="p-season">${ss.map(x => `<option value="${x.start}"${x.start === a.seasonStart ? " selected" : ""}>${seasonLab(x)}</option>`).join("")}</select></label>
  <label class="f">Season starts<input id="p-start" type="date" data-p="seasonStart" value="${esc(a.seasonStart)}"></label>
  <label class="f">Length (weeks)<input id="p-weeks" type="number" min="8" max="104" data-p="weeks" value="${esc(a.weeks || 52)}"></label>
  <label class="f">Hours in the heaviest week<input id="p-hours" type="number" min="5" max="50" step="0.5" data-p="hoursMax" value="${esc(a.hoursMax || 30)}"></label>
  <button data-act="season-next">Start next season</button>
  <span style="flex:1"></span>
  ${st.confirmDel === "ath" ? `<button class="danger" data-act="ath-del2">Delete ${esc(a.name)} and their plan</button><button data-act="del-cancel">Keep</button>` : `<button class="danger" data-act="ath-del">Delete athlete</button>`}
  </div>${age != null || a.strength === "10m" || a.strength === "50m" ? `<p class="muted" style="margin:8px 0 0;font-size:12.5px">${age != null ? `${age <= 20 ? "Junior" : "Senior"}, ${age} this year. ` : ""}${a.strength === "10m" || a.strength === "50m" ? `In Preparation 1, 10% more of the range time goes to ${a.strength === "10m" ? "50m" : "10m"}, the weaker discipline. From Preparation 2 the split follows the next peak only.` : ""}</p>` : ""}${feedProfileHtml(a)}</section>`;
}
function feedFresh() {
  const M = st.feed && st.feed.meta;
  return M
    ? `Rankings feed generated ${fmt(parse(String(M.generated).slice(0, 10)), { year: "numeric" })}, copied into the planner ${fmt(parse(String(M.fetched).slice(0, 10)), { year: "numeric" })}. Ask Claude to refresh it.`
    : "The rankings feed is not loaded. Ask Claude to load it.";
}
function feedProfileHtml(a) {
  if (!a.issfId) return "";
  if (!genderOf(a.issfId))
    return `<p class="banner" style="margin:8px 0 0">${esc(a.issfId)} does not look like an ISSF ID (SH, nation, M or W, date of birth, two digits).</p>`;
  const L = feedEntries(a);
  if (!st.feed) return `<p class="muted" style="margin:8px 0 0;font-size:12.5px">${feedFresh()}</p>`;
  return `<div class="feedp"><span class="lab">Rankings feed</span>${feedWarn()}${
    L.length
      ? `<div class="tw"><table class="num"><thead><tr><th>Event</th><th>Level now</th><th>SD</th><th>Trend per year</th><th>Scores</th><th>Finals</th><th>Medals</th><th>Last score</th></tr></thead><tbody>${L.map(x => `<tr><td>${esc(x.E.label)}${x.k === "PR" ? ` <span class="muted">(not planned)</span>` : ""}</td><td><strong>${f1(x.fa.meanNow)}</strong></td><td>${(+x.fa.sd).toFixed(2)}</td><td>${x.fa.slope > 0 ? "+" : ""}${(+x.fa.slope).toFixed(2)}</td><td>${x.fa.n}</td><td>${x.fa.finals}</td><td>${x.fa.medals}${x.fa.golds ? ` (${x.fa.golds} gold)` : ""}</td><td>${fmt(parse(x.fa.last), { year: "numeric" })}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="muted" style="margin:4px 0 0">No entries for ${esc(a.issfId)}. The feed only includes senior athletes with at least two usable ISSF scores in the last 24 months.</p>`
  }
    <p class="muted" style="margin:6px 0 0;font-size:12.5px">${feedFresh()} Levels are venue-adjusted.</p></div>`;
}
function feedGoalsHtml(a, P) {
  const F = st.feed,
    L = feedEntries(a),
    gl = fgList(a),
    today = iso(Date.now()),
    opt = (v, l, c) => `<option value="${v}"${String(c) === String(v) ? " selected" : ""}>${l}</option>`;
  const head = `<div class="hd"><h2>Goals and pathway</h2><span class="muted">${feedFresh()}</span></div>${feedWarn()}`;
  if (!F)
    return `<section class="panel">${head}<p class="muted" style="margin:0">Goals use the rankings feed for cuts, levels and odds.</p></section>`;
  if (!a.issfId || !L.length)
    return `<section class="panel">${head}<p class="muted" style="margin:0">${a.issfId ? `${esc(a.name)} has no entries in the feed, so goals cannot be worked out. The feed only includes senior athletes with at least two usable ISSF scores in the last 24 months.` : `Add ${esc(a.name)}'s ISSF ID in the profile at the top to set goals against the rankings feed.`}</p></section>`;
  const card = g => {
    const c = goalCalc(a, g),
      E = F.events[g.ev],
      main = P.fg && P.fg.g.id === g.id;
    const comps = E ? (E.benchmarks || []).slice().sort((x, y) => parse(x.start) - parse(y.start)) : [];
    const ctl = `<div class="row" style="gap:8px 12px">
      <label class="f">Event<select id="fe-${g.id}" data-fg="${g.id}|ev">${L.map(x => opt(x.key, esc(x.E.label), g.ev)).join("")}</select></label>
      <label class="f" style="flex:1 1 240px">Target competition<select id="fc-${g.id}" data-fg="${g.id}|compId"><option value="">Choose</option>${comps.map(b => opt(b.compId, `${esc(b.comp)} (${fmt(parse(b.start))})`, g.compId)).join("")}</select></label>
      <label class="f">Outcome<select id="fo-${g.id}" data-fg="${g.id}|out">${opt("final", "Make the final", g.out)}${opt("medal", "Win a medal", g.out)}</select></label>
      <label class="f">Confidence<select id="fz-${g.id}" data-fg="${g.id}|conf">${[50, 70, 85].map(v => opt(v, v + "%", g.conf)).join("")}</select></label>
      <label class="f">Start date<input id="fs-${g.id}" type="date" data-fg="${g.id}|start" value="${esc(g.start || "")}"></label>
      <label class="chk"><input type="radio" name="fgmain" id="fm-${g.id}" data-fgmain="${g.id}"${main ? " checked" : ""}> Show in the plan</label>
      <button class="link danger" data-act="fg-del" data-id="${g.id}">Remove</button></div>
      <label class="f" style="margin-top:6px">Notes<textarea id="fn-${g.id}" data-fg="${g.id}|notes" rows="2" maxlength="1000">${esc(g.notes || "")}</textarea></label>`;
    if (c.err)
      return `<article class="goalc">${ctl}<p class="banner" style="margin:8px 0 0">${esc(c.err)}</p></article>`;
    const b = c.b,
      fa = c.fa,
      lnk = st.cal.events.find(e => e.feedComp === b.compId),
      pk = lnk && (a.picks || {})[lnk.id],
      tier = lnk && pk && pk.on ? (lnk.training ? "small" : pk.tier || lnk.tier) : null;
    const chk = !lnk
      ? `${esc(b.comp)} is not linked to a competition in the calendar yet. Link it in the event list to see it in the plan.`
      : !(pk && pk.on)
        ? `${esc(lnk.name)} is not ticked in ${esc(a.name)}'s plan, so the plan does not prepare for it.`
        : tier !== "peak" && tier !== "key"
          ? `In ${esc(a.name)}'s plan, ${esc(lnk.name)} is a ${tierLab[tier].toLowerCase()} competition. A goal event is usually a peak or key event, so the plan builds and tapers for it.`
          : "";
    const stat = (lab, val, sub) =>
      `<div><span class="lab">${lab}</span><b>${val}</b>${sub ? `<div class="muted">${sub}</div>` : ""}</div>`;
    const ms = c.months,
      mrow =
        M => `<tr class="${M.target ? "tgt" : ""}"><td style="white-space:nowrap"><strong>${mLab(M.m)}</strong></td>
      <td class="num">${M.target ? `<strong>${f1(c.need)}</strong><div class="muted" style="font-size:11.5px">at the venue · ${f1(c.Lend)} adjusted</div>` : f1(M.mil)}</td>
      <td>${M.comps.map(x => `<div>${esc(x.comp)} <span class="muted">${fmt(parse(x.start))}</span></div>`).join("") || `<span class="muted">—</span>`}</td>
      <td class="num">${M.adj != null ? `${f1(M.raw)} / <strong>${f1(M.adj)}</strong><div class="muted" style="font-size:11.5px">${M.sc.map(x => esc(x.c)).join(", ")}</div>` : `<span class="muted">—</span>`}</td>
      <td>${M.status ? `<span class="pill rate-${stCls[M.status]}">${STL[M.status]}</span>` : `<span class="muted">—</span>`}</td>
      <td class="num">${M.trAvg != null ? f1(M.trAvg) + ` <span class="muted">(${M.tr.filter(x => +x.score > 0).length})</span>` : `<span class="muted">—</span>`}${M.tr
        .filter(x => x.note)
        .map(x => `<div class="muted" style="font-size:11.5px">${fmt(parse(x.date))}: ${esc(x.note)}</div>`)
        .join("")}</td></tr>`;
    return `<article class="goalc${main ? " main" : ""}">${ctl}
      <div class="gstats num">
        ${stat("Projected final cut", f1(b.cut8), `80% range ${f1(b.cut8Lo)}–${f1(b.cut8Hi)}`)}
        ${g.out === "medal" ? stat("Projected 3rd-best score", f1(b.cut3), `80% range ${f1(b.cut3Lo)}–${f1(b.cut3Hi)} · typical bronze final ${f1(b.bronze)}`) : ""}
        ${stat(`Level needed (${g.conf}%)`, f1(c.need), `at the venue by ${fmt(parse(b.start), { year: "numeric" })} · ${f1(c.Lend)} venue-adjusted`)}
        ${stat("Level now", f1(fa.meanNow), `venue-adjusted · SD ${(+fa.sd).toFixed(2)} · trend ${fa.slope > 0 ? "+" : ""}${(+fa.slope).toFixed(2)} per year`)}
        ${stat("Projected at the target", f1(c.proj), `at the venue · ${b.nVenue ? `venue difference ${b.vOff8 > 0 ? "+" : ""}${f1(b.vOff8)} from ${b.nVenue} competition${b.nVenue === 1 ? "" : "s"}` : "no venue history"}`)}
        ${stat("Chance of the final", pc(c.pF), "")}
        ${stat("Chance of a medal", pc(c.pM), c.prone ? "from the 3rd-best line" : `final chance × ${(+fa.conv).toFixed(2)} conversion`)}
      </div>
      ${chk ? `<p class="banner" style="margin:8px 0 0">${chk}</p>` : ""}
      <h3 style="margin:12px 0 4px">Pathway</h3>
      <p class="muted" style="margin:0 0 6px;font-size:12.5px">Monthly milestones rise in a straight line from ${f1(c.L0)} (${g.start && parse(g.start) > parse(String(F.meta.generated).slice(0, 10)) ? "projected level at the start date" : "level now"}) to ${f1(c.Lend)}, the level needed with the target venue's usual difference taken off, one month before the competition. Status compares the month's venue-adjusted competition average with its milestone; close means within half the SD (${f1(fa.sd / 2)}).</p>
      <div class="tw"><table class="path"><thead><tr><th>Month</th><th>Milestone</th><th>Feed competitions</th><th>Competition average (raw / adjusted)</th><th>Status</th><th>Training</th></tr></thead><tbody>${ms.map(mrow).join("")}</tbody></table></div></article>`;
  };
  const trs = (a.training || []).slice().sort((x, y) => y.date.localeCompare(x.date)),
    evOpt = L.map(x => opt(x.key, esc(x.E.label))).join("");
  const train = `<h3 style="margin:16px 0 4px">Training scores</h3>
    <form id="tr-form" class="row" style="gap:8px 12px"><label class="f">Date<input id="tr-date" type="date" required value="${today}"></label>
      <label class="f">Event<select id="tr-ev">${evOpt}</select></label><label class="f">Score<input id="tr-score" type="number" step="0.1" min="0" max="700" style="width:90px"></label>
      <label class="f" style="flex:1 1 220px">Note<input id="tr-note" maxlength="200" placeholder="Conditions, focus, what to take from it"></label><button class="pri" type="submit">Add</button></form>
    ${
      trs.length
        ? `<div class="tw" style="margin-top:8px"><table><thead><tr><th>Date</th><th>Event</th><th>Score</th><th>Note</th><th></th></tr></thead><tbody>${trs
            .slice(0, 30)
            .map(
              x =>
                `<tr><td class="num" style="white-space:nowrap">${fmt(parse(x.date), { year: "numeric" })}</td><td>${esc((F.events[x.ev] || {}).label || x.ev)}</td><td class="num">${x.score != null && x.score !== "" ? f1(+x.score) : "—"}</td><td>${esc(x.note || "")}</td><td class="act"><button class="link danger" data-act="tr-del" data-id="${x.id}">Remove</button></td></tr>`,
            )
            .join(
              "",
            )}</tbody></table></div>${trs.length > 30 ? `<p class="muted" style="font-size:12.5px">Showing the latest 30 of ${trs.length}.</p>` : ""}`
        : `<p class="muted" style="margin:6px 0 0;font-size:12.5px">Training scores appear in the pathway month they fall in, next to the competition averages.</p>`
    }`;
  return `<section class="panel">${head}${gl.length ? gl.map(card).join("") : `<p class="muted" style="margin:0 0 8px">Set a goal: an event, a target competition from the feed, make the final or win a medal, and how confident you want to be. The goal's pathway then sits in the plan above.</p>`}
    <button class="pri" data-act="fg-add" style="margin-top:8px">Add a goal</button>${train}</section>`;
}
function backupHtml() {
  const R = st.restore;
  return `<section class="panel"><div class="hd"><h2>Backup</h2><span class="muted">All athletes, their plans, goals, results and training scores, and the shared calendar</span></div>
  ${
    R
      ? `<div class="banner"><strong>Restore ${esc(R.name)}?</strong> It was saved ${R.data.exported ? fmt(parse(String(R.data.exported).slice(0, 10)), { year: "numeric" }) : "on an unknown date"} and holds ${Object.keys(R.data.athletes).length} athlete${Object.keys(R.data.athletes).length === 1 ? "" : "s"} and ${R.data.calendar.events.length} calendar events. It replaces every athlete and the calendar here; anything added since the backup is lost.
    <div class="row" style="margin-top:8px"><button class="pri" data-act="bk-restore">Replace with the backup</button><button data-act="bk-cancel">Cancel</button></div></div>`
      : `<div class="row">${st.dl ? `<button class="pri" data-act="bk-save">Download a backup</button>` : `<span class="muted">Downloads are not available in this view.</span>`}
    <label class="f">Restore from a backup file<input id="bk-file" type="file" accept=".json,application/json"></label></div>`
  }
  ${st.bkMsg ? `<p style="margin:8px 0 0">${esc(st.bkMsg)}</p>` : ""}
  <p class="muted" style="margin:8px 0 0;font-size:12.5px">The rankings feed is not part of the backup; it comes from its own repository.</p></section>`;
}
function notesHtml(a) {
  return `<section class="panel"><div class="hd"><h2>Notes on ${esc(a.name)}</h2></div>
  <label class="f">Athlete notes<textarea id="g-notes" data-p="notes" rows="7" maxlength="6000" placeholder="Anything that should stay with this athlete from season to season: equipment, injuries, what works in competition.">${esc(a.notes || "")}</textarea></label>
  <p class="muted" style="margin:8px 0 0;font-size:12.5px">Notes stay with the athlete across seasons. Each goal has its own notes, and each week has a note in its week card.</p></section>`;
}
function resultsHtml(a, P) {
  const R = a.results || {},
    cs = P.evs.filter(e => e.type === "comp").sort((x, y) => x.st - y.st),
    f = x => String(Math.round(x * 10) / 10);
  const FS = {};
  cs.forEach(e => {
    FS[e.id] = feedScore(a, e);
  });
  const scoreOf = (e, k) => (FS[e.id][k] ? FS[e.id][k].s : +(R[e.id] || {})[k]);
  const qCell = (e, k) =>
    FS[e.id][k]
      ? `<strong class="num">${f(FS[e.id][k].s)}</strong> <span class="muted" style="font-size:12px" title="From the rankings feed: ${esc(FS[e.id][k].c)}, qualification rank ${esc(FS[e.id][k].p)}">ISSF · ${esc(FS[e.id][k].p)}.</span>`
      : inp(e, k, "Score", "76px", 1);
  const stat = (k, lab, col) => {
    const v = cs.map(e => scoreOf(e, k)).filter(x => x > 0);
    if (!v.length) return "";
    const lo = Math.min(...v),
      hi = Math.max(...v),
      W = 150,
      H = 34,
      X = i => 6 + (i * (W - 12)) / Math.max(1, v.length - 1),
      Y = x => (hi === lo ? H / 2 : H - 6 - ((x - lo) / (hi - lo)) * (H - 12));
    return `<div class="rstat"><span class="lab">${lab}</span><div class="num"><b>${f(v[v.length - 1])}</b> latest · best ${f(hi)} · average ${f(v.reduce((t, x) => t + x, 0) / v.length)} · ${v.length} result${v.length === 1 ? "" : "s"}</div>
      ${v.length > 1 ? `<svg width="${W}" height="${H}" role="img" aria-label="${lab} scores in date order, from ${f(v[0])} to ${f(v[v.length - 1])}"><polyline points="${v.map((x, i) => X(i) + "," + Y(x)).join(" ")}" fill="none" stroke="var(--${col})" stroke-width="1.8"/>${v.map((x, i) => `<circle cx="${X(i)}" cy="${Y(x)}" r="${i === v.length - 1 ? 3.5 : 2.2}" fill="var(--${col})"><title>${f(x)}</title></circle>`).join("")}</svg>` : ""}</div>`;
  };
  const inp = (e, k, ph, w, num) =>
    `<input id="rs-${e.id}-${k}" data-res="${e.id}|${k}" ${num ? `type="number" step="0.1" min="0" max="700"` : `maxlength="${k === "note" ? 200 : 40}"`} style="width:${w}" placeholder="${ph}" value="${esc((R[e.id] || {})[k] || "")}" aria-label="${ph} for ${esc(e.name)}">`;
  return `<section class="panel"><div class="hd"><h2>Results</h2><span class="muted">${cs.length} competition${cs.length === 1 ? "" : "s"} in ${esc(a.name)}'s season</span></div>
  ${
    cs.length
      ? `<div class="row" style="gap:16px 28px;margin-bottom:10px;align-items:flex-start">${stat("q10", "10m qualification", "c10")}${stat("q50", "50m 3P qualification", "c50")}</div>
  <div class="tw"><table><thead><tr><th>Date</th><th>Competition</th><th>10m</th><th>50m 3P</th><th>Final or place</th><th>Reflection</th></tr></thead><tbody>${cs
    .map(
      e => `<tr>
    <td class="num" style="white-space:nowrap">${range(e.st, e.en)}</td><td>${esc(e.name)} <span class="muted">· ${e.training ? "Training match" : tierLab[e.tier]}</span></td>
    <td>${e.disc !== "50m" ? qCell(e, "q10") : ""}</td><td>${e.disc !== "10m" ? qCell(e, "q50") : ""}</td><td>${inp(e, "place", "e.g. 5th, final", "120px")}</td><td>${inp(e, "note", "What to take from it", "100%;min-width:170px")}</td></tr>`,
    )
    .join("")}</tbody></table></div>
  <p class="muted" style="margin:8px 0 0;font-size:12.5px">Enter qualification scores as shot. ISSF scores fill in from the rankings feed, with the qualification rank, once the feed has them. The lines above show all scores in date order for this season.</p>`
      : `<p class="muted" style="margin:0">No competitions are ticked for ${esc(a.name)} in this season yet.</p>`
  }</section>`;
}

function yearHtml(a, P) {
  const host = $("app"),
    avail = Math.max(320, (host.clientWidth || 1200) - 30),
    LW = avail < 700 ? 78 : 112,
    Z = st.zoom || 1,
    CW = Math.max(20, Math.floor((avail - LW - 2) / P.N)) * Z,
    TW = CW * P.N,
    det = CW >= 40,
    wide = CW >= 76;
  const row = (lab, h, inner) =>
    `<div class="tr"><div class="tl-l" style="width:${LW}px;height:${h}px">${lab}</div><div class="tl-t" style="width:${TW}px;height:${h}px">${inner}</div></div>`;
  let mon = "",
    wk = "",
    lastM = -1;
  P.W.forEach(w => {
    const d = new Date(w.start),
      m = d.getUTCMonth();
    if (m !== lastM) {
      mon += `<div class="mon" style="left:${w.i * CW}px">${fmt(w.start, { day: undefined, month: "short" })}${m === 0 || w.i === 0 ? " " + d.getUTCFullYear() : ""}</div>`;
      lastM = m;
    }
    wk += `<div class="wk num${w.i % 4 === 0 ? " gridl" : ""}${w.manual ? " man" : ""}" style="left:${w.i * CW}px;width:${CW}px">${det ? (wide ? "Wk " : "") + (w.i + 1) + " · " + fmt(w.start) : w.i + 1}</div>`;
  });
  const ph = P.blocks
    .map((b, bi) => {
      let o = "";
      for (let i = b.start; i < b.start + b.len; ) {
        let j = i;
        while (j + 1 < b.start + b.len && P.W[j + 1].phase === P.W[i].phase) j++;
        const p = P.W[i].phase,
          wd = (j - i + 1) * CW - (j === b.start + b.len - 1 ? 2 : 0);
        o += `<div class="ph ${p}" style="left:${i * CW}px;width:${wd}px;background:var(--${p.toLowerCase()})" title="${PH[p].n}">${wd > 120 && det ? PH[p].n : wd > 44 ? PH[p].s : ""}</div>`;
        i = j + 1;
      }
      return o;
    })
    .join("");
  const lane = (filter, cls) =>
    laneHtml(
      P.W.flatMap(w => w.events.filter(e => e.w0 === w.i)).filter(filter),
      CW,
      cls,
      det ? { s0: P.s0, end: P.s0 + P.N * WEEK - DAY } : null,
    );
  const l10 = lane(e => e.type === "comp" && e.disc !== "50m"),
    l50 = lane(e => e.type === "comp" && e.disc !== "10m"),
    lc = lane(e => e.type === "camp", "camp"),
    lh = lane(e => e.type === "hol", "hol");
  const LH = 64,
    bars = P.W.map(w => {
      const h = (w.load / 100) * (LH - 8);
      return `<rect x="${w.i * CW + 2}" y="${LH - h}" width="${CW - 4}" height="${h}" rx="2" fill="var(--${w.phase.toLowerCase()})"><title>Week ${w.i + 1}: volume ${w.load}%, about ${hrs(w.hours)} h, intensity ${w.inten}/10</title></rect>`;
    }).join("");
  const pts = P.W.map(w => `${w.i * CW + CW / 2},${LH - 3 - (w.inten / 10) * (LH - 10)}`).join(" ");
  const load = `<svg width="${TW}" height="${LH}" style="left:0;top:0" role="img" aria-label="Weekly training volume and mental intensity"><line x1="0" x2="${TW}" y1="${LH - (LH - 8) * 0.5}" y2="${LH - (LH - 8) * 0.5}" stroke="var(--line)" stroke-dasharray="3 3"/>${bars}<polyline points="${pts}" fill="none" stroke="var(--fg)" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  const heat = (k, col, mx) =>
    P.W.map(w => {
      const v = w.split[k];
      return v > 0.05
        ? `<div class="heat" style="left:${w.i * CW + 1}px;width:${CW - 2}px;background:color-mix(in srgb,var(--${col}) ${Math.round(clamp(v / mx, 0.08, 1) * 100)}%,transparent)" title="Week ${w.i + 1}: ${hrs(v)} h">${det ? hrs(v) + " h" : ""}</div>`
        : "";
    }).join("");
  const cell = (w, lines) =>
    `<div class="wd num" style="left:${w.i * CW}px;width:${CW}px">${lines.map(l => `<div>${l}</div>`).join("")}</div>`;
  const planRow = det
    ? row(
        "WEEK PLAN",
        46,
        P.W.map(w =>
          cell(
            w,
            [`<b title="${esc(w.type)}">${esc(w.type)}</b>`].concat(
              wide
                ? [`${w.load}% · ${hrs(w.hours)} h`, `Intensity ${w.inten}/10`]
                : [`${w.load}%`, `${hrs(w.hours)} h`],
            ),
          ),
        ).join(""),
      )
    : "";
  const shotRow = det
    ? row(
        "LIVE SHOTS",
        wide ? 46 : 33,
        P.W.map(w =>
          w.shots10 + w.shots50 > 0
            ? cell(
                w,
                [`10m ${w.shots10}`, `50m ${w.shots50}`].concat(
                  wide && w.shots50 ? [`K${w.pos.k} P${w.pos.p} S${w.pos.s}`] : [],
                ),
              )
            : "",
        ).join(""),
      )
    : "";
  const zb = (z, l) =>
    `<button data-act="zoom" data-id="${z}" class="${Z === z ? "on" : ""}" aria-pressed="${Z === z}">${l}</button>`;
  const mx = k => Math.max(1, ...P.W.map(w => w.split[k])),
    mt = Math.max(mx("t10"), mx("t50"));
  const b = P.blocks[st.sel],
    now = (Date.now() - P.s0) / WEEK;
  return `<section class="panel"><div class="hd"><h2>Season ${fmt(P.s0, { year: "numeric" })} – ${fmt(P.s0 + P.N * WEEK - DAY, { year: "numeric" })}</h2><div class="row" style="align-items:center"><span class="muted">Select any week to open its 4-week block</span><div class="seg" role="group" aria-label="Timeline zoom">${zb(1, "Year")}${zb(2, "Half")}${zb(4, "Quarter")}</div></div></div>
  <div class="tl"><div class="tl-in" id="tl" data-lw="${LW}" data-cw="${CW}" style="width:${LW + TW}px">
    ${row("", 18, mon)}${row("WEEK", 16, wk)}${row("PHASE", 26, ph)}${row("10M EVENTS", l10.h, l10.html)}${row("50M EVENTS", l50.h, l50.html)}${row("CAMPS", lc.h, lc.html)}${row("HOLIDAYS", lh.h, lh.html)}
    ${row("VOLUME", LH, load)}${planRow}${shotRow}${row("10M RANGE", 18, heat("t10", "c10", mt))}${row("50M RANGE", 18, heat("t50", "c50", mt))}${row("FINALS", 18, heat("fin", "comp", Math.max(1, mx("fin"))))}${row("PHYSICAL", 18, heat("phys", "cphys", mx("phys")))}${row("MENTAL", 18, heat("mental", "cment", mx("mental")))}${row("RECOVERY", 18, heat("rec", "crec", mx("rec")))}${
      P.fg
        ? row(
            "PATHWAY",
            18,
            P.W.map(w => {
              const M = monthOf(P, w.start + 3 * DAY);
              if (!M) return "";
              const col = M.target
                ? "comp"
                : M.status === "on"
                  ? "pp1"
                  : M.status === "close"
                    ? "warn"
                    : M.status === "behind"
                      ? "comp"
                      : "line";
              return `<div class="heat" style="left:${w.i * CW + 1}px;width:${CW - 2}px;background:color-mix(in srgb,var(--${col}) ${M.status || M.target ? 75 : 45}%,transparent)" title="${mLab(M.m)}: ${M.target ? "target month, level needed " + f1(P.fg.need) : "milestone " + f1(M.mil) + (M.adj != null ? ", adjusted average " + f1(M.adj) : "") + (M.status ? ", " + STL[M.status].toLowerCase() : "")}">${det && new Date(w.start).getUTCDate() <= 7 ? (M.target ? "Target" : f1(M.mil)) : ""}</div>`;
            }).join(""),
          )
        : ""
    }
    <div class="sel" style="left:${LW + b.start * CW}px;width:${b.len * CW}px"></div>${now >= 0 && now < P.N ? `<div class="today" style="left:${LW + now * CW}px" title="Today"></div>` : ""}
  </div></div>
  <div class="legend">${Object.keys(PH)
    .map(k => `<span><b class="sw-${k}"></b>${PH[k].n}</span>`)
    .join("")}
    <span><b style="background:var(--comp)"></b>★ Peak</span><span><b style="background:var(--warn)"></b>◆ Key</span><span><b style="background:var(--fg)"></b>Major</span><span><b style="border:2px solid var(--fg)"></b>Minor</span>
    <span>Bars: weekly volume (dashed line 50%)</span><span>Line: mental intensity 1–10</span><span>Shaded rows: hours, darker is more</span><span>Dashed vertical: today</span><span>Highlighted week number: adjusted by hand</span>${P.fg ? `<span>Pathway row: monthly milestone towards ${esc(P.fg.b.comp)}, green on track, amber close, red behind, grey no competition yet</span>` : ""}</div></section>`;
}
function monthHtml(a, P) {
  const end = P.s0 + P.N * WEEK - DAY,
    today = iso(Date.now()),
    evs = [...new Set(P.W.flatMap(w => w.events))];
  let out = "",
    d = new Date(P.s0),
    y = d.getUTCFullYear(),
    m = d.getUTCMonth();
  const head = `<div class="mhead"><div>Week</div>${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(x => `<div>${x}</div>`).join("")}</div>`;
  while (Date.UTC(y, m, 1) <= end) {
    const first = Date.UTC(y, m, 1),
      last = Date.UTC(y, m + 1, 0);
    let rows = "";
    for (let ws = mondayOf(first); ws <= last; ws += WEEK) {
      const wi = Math.round((ws - P.s0) / WEEK),
        w = P.W[wi];
      let cells = "";
      for (let k = 0; k < 7; k++) {
        const day = ws + k * DAY,
          inM = day >= first && day <= last && day >= P.s0 && day <= end;
        const ch = inM
          ? evs
              .filter(e => e.st <= day && e.en >= day)
              .map(e => {
                const c = e.type === "comp" ? e.tier : e.type,
                  lead = e.st === day || k === 0 || day === first,
                  more = lead && e.en > day && k < 6 && day < last;
                return `<div class="chip ${c}${lead ? "" : " cont"}${more ? " spill" : ""}" title="${esc(e.name)} · ${range(e.st, e.en)}${e.type === "comp" ? " · " + tierLab[e.tier] : ""}">${lead ? (c === "peak" ? "★ " : c === "key" ? "◆ " : "") + esc(e.name) : "&nbsp;"}</div>`;
              })
              .join("")
          : "";
        cells += `<div class="day${inM ? "" : " out"}${inM && iso(day) === today ? " now" : ""}">${inM ? `<span class="dn num">${new Date(day).getUTCDate()}</span>${ch}` : ""}</div>`;
      }
      rows += w
        ? `<div class="mrow" data-mw="${wi}" style="--pc:var(--${w.phase.toLowerCase()})"><div class="wsum num"${P.wn[iso(w.start)] ? ` title="${esc(P.wn[iso(w.start)])}"` : ""}><b>Wk ${wi + 1}</b> · ${PH[w.phase].s}<div>${esc(w.type)}${w.manual ? " (hand-set)" : ""}</div><div>${w.load}% · ${hrs(w.hours)} h</div>${w.shots10 + w.shots50 ? `<div class="muted">${w.shots10 + w.shots50} shots</div>` : ""}${P.wn[iso(w.start)] ? `<div class="clip" style="color:var(--accent)">Note: ${esc(P.wn[iso(w.start)])}</div>` : ""}</div>${cells}</div>`
        : `<div class="mrow off"><div class="wsum muted">Outside the season</div>${cells}</div>`;
    }
    const PM = monthOf(P, first);
    out += `<section class="mon-b"><h3>${fmt(first, { day: undefined, month: "long", year: "numeric" })}</h3>${PM ? `<div class="mpath">${pathLine(PM, P.fg)}${PM.comps.length ? `<div class="muted">${PM.comps.map(x => esc(x.comp)).join(", ")}</div>` : ""}</div>` : ""}<div class="mscroll"><div class="mgrid">${head}${rows}</div></div></section>`;
    if (++m > 11) {
      m = 0;
      y++;
    }
  }
  return `<section class="panel"><div class="hd"><h2>${esc(a.name)}: month calendar</h2><span class="muted">Select a week to open its 4-week block</span></div>
  <div class="months">${out}</div>
  <div class="legend">${Object.keys(PH)
    .map(k => `<span><b class="sw-${k}"></b>${PH[k].n} (row tint)</span>`)
    .join(
      "",
    )}<span><span class="chip peak" style="display:inline-block">★ Peak</span></span><span><span class="chip key" style="display:inline-block">◆ Key</span></span><span><span class="chip major" style="display:inline-block">Major</span></span><span><span class="chip small" style="display:inline-block">Minor</span></span><span><span class="chip camp" style="display:inline-block">Camp</span></span><span><span class="chip hol" style="display:inline-block">Holiday</span></span></div></section>`;
}
function suggestHtml(P, a) {
  const S = suggest(P, a);
  return `<section class="panel"><div class="hd"><h2>Suggestions</h2>${S.hidden ? `<button class="link" data-act="sg-restore">Show ${S.hidden} dismissed</button>` : ""}</div>
  ${
    S.list.length
      ? `<ul class="sugg">${S.list.map(x => `<li class="${x.cls || ""}"><strong>${esc(x.t)}</strong><div>${esc(x.why)}</div><div class="row" style="margin-top:6px;gap:6px">${x.acts.map(b => `<button data-act="${b.a}" data-id="${b.id}"${b.v ? ` data-v="${b.v}"` : ""}>${esc(b.l)}</button>`).join("")}<button class="link" data-act="sg-dismiss" data-id="${esc(x.key)}">Dismiss</button></div></li>`).join("")}</ul>
  <p class="muted" style="margin:8px 0 0;font-size:12.5px">The buttons change ${esc(a.name)}'s plan only. The shared calendar and other athletes stay as they are, and you can reverse a change in the event list.</p>`
      : `<p class="muted" style="margin:0">No suggestions. Nothing in ${esc(a.name)}'s calendar is working against the plan.</p>`
  }</section>`;
}
function laneHtml(list, CW, cls, o) {
  const rows = [];
  let html = "";
  list
    .slice()
    .sort((x, y) => x.st - y.st)
    .forEach(e => {
      const k = cls || e.tier,
        label = o || k !== "small",
        da = o ? Math.max(e.st, o.s0) : 0,
        db = o ? Math.min(e.en, o.end) : 0,
        left = o ? ((da - o.s0) / WEEK) * CW + 1 : e.w0 * CW + 2,
        bw = o
          ? Math.max(9, (((db - da) / DAY + 1) / 7) * CW - 2)
          : Math.max(CW - 4, (e.w1 - e.w0 + 1) * CW - 4),
        text = e.name + (o ? " · " + range(e.st, e.en) : ""),
        need = left + bw + (label ? text.length * 6 + 10 : 2);
      let r = rows.findIndex(end => end <= left);
      if (r < 0) {
        r = rows.length;
        rows.push(0);
      }
      rows[r] = need;
      html += `<div class="ev ${k}" style="left:${left}px;top:${3 + r * 18}px" title="${esc(e.name)} · ${range(e.st, e.en)}${e.type === "comp" ? " · " + tierLab[e.tier] : ""}"><i style="width:${bw}px">${k === "peak" ? "★" : k === "key" ? "◆" : ""}</i>${label ? `<span>${esc(text)}</span>` : ""}</div>`;
    });
  return { h: Math.max(1, rows.length) * 18 + 5, html };
}
function squadHtml(ids) {
  const pl = ids.map(id => ({ id, a: st.athletes[id], P: plan(view(st.athletes[id])) }));
  const s0 = Math.min(...pl.map(x => x.P.s0)),
    end = Math.max(...pl.map(x => x.P.s0 + x.P.N * WEEK)),
    N = Math.round((end - s0) / WEEK),
    now = Date.now();
  const host = $("app"),
    avail = Math.max(320, (host.clientWidth || 1200) - 30),
    LW = avail < 700 ? 92 : 150,
    CW = Math.max(18, Math.floor((avail - LW - 2) / N)),
    TW = CW * N;
  const row = (lab, h, inner, attr) =>
    `<div class="tr"${attr || ""}><div class="tl-l" style="width:${LW}px;height:${h}px"><span class="clip">${lab}</span></div><div class="tl-t" style="width:${TW}px;height:${h}px">${inner}</div></div>`;
  let mon = "",
    lastM = -1;
  for (let i = 0; i < N; i++) {
    const d = new Date(s0 + i * WEEK),
      m = d.getUTCMonth();
    if (m !== lastM) {
      mon += `<div class="mon" style="left:${i * CW}px">${fmt(s0 + i * WEEK, { day: undefined, month: "short" })}${m === 0 || i === 0 ? " " + d.getUTCFullYear() : ""}</div>`;
      lastM = m;
    }
  }
  const cal = st.cal.events
    .filter(e => e.start)
    .map(e => {
      const a = parse(e.start),
        b = Math.max(a, parse(e.end || e.start));
      return Object.assign({}, e, {
        st: a,
        en: b,
        w0: Math.floor((a - s0) / WEEK),
        w1: Math.floor((b - s0) / WEEK),
      });
    })
    .filter(e => e.w1 >= 0 && e.w0 < N)
    .map(e => Object.assign(e, { w0: clamp(e.w0, 0, N - 1), w1: clamp(e.w1, 0, N - 1) }));
  const lc = laneHtml(
      cal.filter(e => e.type === "comp"),
      CW,
    ),
    lk = laneHtml(
      cal.filter(e => e.type === "camp"),
      CW,
      "camp",
    );
  const rows = pl
    .map(({ id, a, P }) => {
      const off = Math.round((P.s0 - s0) / WEEK);
      let o = "";
      for (let i = 0; i < P.N; ) {
        let j = i;
        while (j + 1 < P.N && P.W[j + 1].phase === P.W[i].phase) j++;
        const ph = P.W[i].phase,
          wd = (j - i + 1) * CW - 1;
        o += `<div class="ph ${ph}" style="left:${(off + i) * CW}px;width:${wd}px;top:4px;background:var(--${ph.toLowerCase()})" title="${PH[ph].n}">${wd > 60 ? PH[ph].s : ""}</div>`;
        i = j + 1;
      }
      P.W.forEach(w => {
        const c = w.events.filter(e => e.type === "comp"),
          g = c.some(e => e.tier === "peak")
            ? "★"
            : c.some(e => e.tier === "key")
              ? "◆"
              : c.some(e => e.tier === "major")
                ? "●"
                : w.events.some(e => e.type === "camp")
                  ? "▲"
                  : w.hol >= 5
                    ? "H"
                    : c.length
                      ? "○"
                      : "";
        if (g)
          o += `<div class="gl" style="left:${(off + w.i) * CW}px;width:${CW}px" title="${esc(w.events.map(e => e.name).join(", "))}">${g}</div>`;
      });
      return row(esc(a.name), 44, o, ` data-sq="${id}" data-off="${off}"`);
    })
    .join("");
  const nowW = (now - s0) / WEEK;
  const tbl = pl
    .map(({ id, a, P }) => {
      const ni = Math.floor((now - P.s0) / WEEK),
        w = ni >= 0 && ni < P.N ? P.W[ni] : null,
        pk = P.clusters.flatMap(c => c.peaks).find(p => p.en >= now),
        nw = P.flags.filter(f => f.lv === "warn").length,
        fg = mainGoal(a),
        gm = fg && fg.months.find(x => x.m === mS(now));
      return `<tr><td><strong>${esc(a.name)}</strong></td><td>${w ? `<span class="pill">${PH[w.phase].n}</span> ${esc(w.type)}` : `<span class="muted">Outside season</span>`}</td><td class="num">${w ? w.load + "%" : "—"}</td><td class="num">${w ? hrs(w.hours) + " h" : "—"}</td>
      <td>${pk ? esc(pk.name) + ` <span class="muted">· ${Math.max(0, Math.ceil((pk.st - now) / WEEK))} wk</span>` : `<span class="muted">None set</span>`}</td>
      <td>${fg ? `${esc(fg.b.comp)} <span class="muted">· ${fg.g.out === "medal" ? "medal" : "final"}, ${pc(fg.pF)} final chance</span>${gm ? `<div>${gm.target ? "Target month" : `Milestone ${f1(gm.mil)}${gm.adj != null ? ` · ${f1(gm.adj)} adjusted` : ""}`} ${gm.status ? `<span class="pill rate-${stCls[gm.status]}">${STL[gm.status]}</span>` : ""}</div>` : ""}` : `<span class="muted">No goal</span>`}</td><td>${nw ? `<span class="pill" style="border-color:var(--warn);color:var(--warn)">${nw} conflict${nw === 1 ? "" : "s"}</span>` : `<span class="muted">Clear</span>`}</td>
      <td class="act"><button class="link" data-act="open-ath" data-id="${id}">Open plan</button></td></tr>`;
    })
    .join("");
  return `<section class="panel"><div class="hd"><h2>Squad overview</h2><span class="muted">${pl.length} athlete${pl.length === 1 ? "" : "s"} · select a week in an athlete's row to open that block</span></div>
  <div class="tl"><div class="tl-in" id="sq" data-lw="${LW}" data-cw="${CW}" style="width:${LW + TW}px">
    ${row("", 18, mon)}${row("COMPETITIONS", lc.h, lc.html)}${row("CAMPS", lk.h, lk.html)}${rows}
    ${nowW >= 0 && nowW < N ? `<div class="today" style="left:${LW + nowW * CW}px" title="Today"></div>` : ""}
  </div></div>
  <div class="legend">${Object.keys(PH)
    .map(k => `<span><b class="sw-${k}"></b>${PH[k].n}</span>`)
    .join(
      "",
    )}<span>In an athlete's row: ★ peak · ◆ key · ● major · ○ minor · ▲ camp · H holiday week</span><span>Top rows show the whole shared calendar</span><span>Dashed vertical: today</span></div></section>
  <section class="panel"><div class="hd"><h2>This week</h2><span class="muted">${fmt(mondayOf(now))} – ${fmt(mondayOf(now) + 6 * DAY, { year: "numeric" })}</span></div>
  <div class="tw"><table><thead><tr><th>Athlete</th><th>Phase and week</th><th>Volume</th><th>Hours</th><th>Next peak</th><th>Goal this month</th><th>Checks</th><th></th></tr></thead><tbody>${tbl}</tbody></table></div></section>`;
}
function flagsHtml(P) {
  const nW = P.flags.filter(f => f.lv === "warn").length,
    nI = P.flags.length - nW,
    open = st.checksOpen != null ? st.checksOpen : nW > 0;
  return `<section class="panel"><details id="checks" class="checks"${open ? " open" : ""}><summary><h2>Checks on this plan</h2>${nW ? `<span class="pill" style="border-color:var(--warn);color:var(--warn)">${nW} conflict${nW === 1 ? "" : "s"}</span>` : `<span class="pill rate-ok">No conflicts</span>`}${nI ? `<span class="muted">${nI} note${nI === 1 ? "" : "s"}</span>` : ""}</summary>${P.flags.length ? `<ul class="flags">${P.flags.map(f => `<li class="${f.lv}"><span class="tag">${f.lv === "warn" ? "Conflict" : "Note"}${f.w != null ? " · wk " + (f.w + 1) : ""}</span>${esc(f.t)}${f.d ? `<details class="why"><summary>Why the plan looks like this</summary><ul>${f.d.map(x => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}</li>`).join("")}</ul>` : `<p class="muted" style="margin:0">No conflicts. Every peak has a full build, taper and recovery.</p>`}</details></section>`;
}
/* ---------- weekly log ---------- */
const LOGF = {
  fatigue: [["fresh", "Fresh"], ["normal", "Normal"], ["tired", "Tired"], ["very", "Very tired"]],
  health: [["fine", "Fine"], ["niggle", "Niggle"], ["ill", "Ill"], ["injured", "Injured"]],
  tech: [["good", "Good"], ["mixed", "Mixed"], ["poor", "Poor"]],
  perf: [["good", "Good"], ["mixed", "Mixed"], ["poor", "Poor"]],
};
const WORKED = [["ar", "Air rifle"], ["k", "Kneeling"], ["p", "Prone"], ["s", "Standing"], ["fin", "Finals"], ["phys", "Physical"], ["ment", "Mental"]];
function logHtml(w, P) {
  const k = iso(w.start),
    l = w.log || {},
    logged = Object.keys(l).length > 0,
    sel = (f, lab, opts) =>
      `<label class="f">${lab}<select id="lg-${k}-${f}" data-log="${k}|${f}"><option value="">—</option>${opts.map(([v, t]) => `<option value="${v}"${String(l[f] || "") === String(v) ? " selected" : ""}>${t}</option>`).join("")}</select></label>`,
    box = (f, v, t) =>
      `<label class="chk"><input type="checkbox" id="lc-${k}-${f}-${v}" data-logc="${k}|${f}|${v}"${(l[f] || []).includes(v) ? " checked" : ""}> ${t}</label>`;
  return `<details class="log"${logged || (P.wn || {})[k] ? " open" : ""}><summary>Week log${logged ? " · logged" : ""}</summary>
    <div class="row" style="gap:6px 10px">
      ${sel("load", "Load felt", Array.from({ length: 10 }, (_, i) => [i + 1, `${i + 1}${i === 0 ? " very easy" : i === 9 ? " maximal" : ""}`]))}
      ${sel("fatigue", "Fatigue", LOGF.fatigue)}${sel("health", "Health", LOGF.health)}
      ${sel("tech", "Technical work", LOGF.tech)}${sel("perf", "Scores", LOGF.perf)}
    </div>
    ${l.health === "niggle" || l.health === "injured" ? `<div class="row" style="gap:4px 12px;margin-top:4px"><span class="lab">Affects</span>${[["ar", "Air rifle"], ["k", "Kneeling"], ["p", "Prone"], ["s", "Standing"]].map(([v, t]) => box("affects", v, t)).join("")}</div>` : ""}
    <div class="row" style="gap:4px 12px;margin-top:4px"><span class="lab">Worked on</span>${WORKED.map(([v, t]) => box("worked", v, t)).join("")}</div>
    <label class="f" style="margin-top:6px">What we did and how it went<textarea id="wn-${k}" data-wn="${k}" rows="3" maxlength="2000" placeholder="Sessions, what worked, what didn't, anything to remember">${esc((P.wn || {})[k] || "")}</textarea></label>
    <p class="muted" style="margin:4px 0 0;font-size:12px">The ratings adjust next week's plan. The text is read only when you ask Claude to review the block.</p></details>`;
}
function logAdjHtml(w) {
  if (!w.logAdj || !w.logAdj.length) return "";
  return `<div class="logadj"><span class="lab">From last week's log</span>${w.logAdj
    .map(x => `<div class="${x.ign ? "ign" : ""}">${esc(x.text)}${st.role === "coach" ? ` <button class="link" data-act="log-ign" data-id="${esc(x.key)}">${x.ign ? "Apply again" : "Ignore"}</button>` : x.ign ? " (your coach has set this aside)" : ""}</div>`)
    .join("")}</div>`;
}

/* ---------- block review by Claude (on request; proposals need the coach's approval) ---------- */
function reviewWindow(P, bi) {
  const b = P.blocks[bi],
    nb = P.blocks[bi + 1],
    now = mondayOf(Date.now()),
    first = Math.max(b.start, Math.min(P.N - 1, Math.max(0, Math.floor((now - P.s0) / WEEK)))),
    last = (nb ? nb.start + nb.len : b.start + b.len) - 1;
  return { first: Math.min(first, last), last };
}
function reviewPrompt(a, P, bi) {
  const b = P.blocks[bi],
    pb = P.blocks[bi - 1],
    R = reviewWindow(P, bi),
    from = pb ? pb.start : b.start,
    wk = w => ({
      week: iso(w.start),
      phase: PH[w.phase].n,
      weekType: w.type,
      volumePercent: w.load,
      hours: w.hours,
      intensity: w.inten,
      finalsHours: Math.round(w.split.fin * 10) / 10,
      liveShots10m: w.shots10,
      liveShots50m: w.shots50,
      events: w.events.map(e => `${e.name} (${e.type === "comp" ? (e.training ? "training match" : tierLab[e.tier].toLowerCase() + " competition") : e.type === "camp" ? "camp" : "holiday"})`),
      log: w.log || null,
      coachNotes: (P.wn || {})[iso(w.start)] || null,
      adjustmentsFromLog: w.logAdj.filter(x => !x.ign).map(x => x.text),
      setByHand: !!w.manual,
    }),
    now = Date.now(),
    comps = P.evs
      .filter(e => e.type === "comp" && e.en >= now && e.st <= now + 16 * WEEK)
      .map(e => ({ eventId: e.id, name: e.name, start: iso(e.st), discipline: e.disc, priority: e.training ? "training match" : tierLab[e.tier].toLowerCase() })),
    fg = P.fg;
  const data = {
    athlete: a.name,
    today: iso(now),
    strongerDiscipline: a.strength || "balanced",
    blockBeingReviewed: `weeks ${b.start + 1}-${b.start + b.len}, ${b.pattern}`,
    weeks: P.W.slice(from, R.last + 1).map(wk),
    upcomingCompetitions: comps,
    seasonGoal: fg ? { competition: fg.b.comp, outcome: fg.g.out, levelNow: fg.fa.meanNow, levelNeeded: fg.need, chanceOfFinal: Math.round(fg.pF * 100) + "%" } : null,
  };
  return `You are helping an elite rifle coach (10m air rifle and 50m rifle 3 positions) adjust a periodised training plan.
Below is the plan for the previous block, this block and the next one, with the coach's weekly logs. Log fields: load = how hard the week felt (1-10), fatigue (fresh/normal/tired/very), health (fine/niggle/ill/injured, with affected positions), tech = how the technical work went, perf = how the scores went, worked = what was worked on (ar air rifle, k kneeling, p prone, s standing, fin finals, phys physical, ment mental). The planner has already applied "adjustmentsFromLog".

Review how the block is going and propose at most 5 changes, only where the logs and notes give a reason. You may:
- change a week between ${iso(P.W[R.first].start)} and ${iso(P.W[R.last].start)} (week start dates as given): volumePercent 0-110, intensity 1-10, or phase (PP1 general preparation, PP2 specific preparation, COMP competition, AREC active recovery);
- change the priority of an upcoming competition (minor, major, key, peak);
- add a note for the coach.
Do not repeat changes the planner has already made. Keep each reason to one sentence a coach would accept. If nothing needs changing, return an empty proposals list and say so in the summary.

Reply with only JSON in this shape:
{"summary":"two or three sentences","proposals":[{"kind":"week","week":"YYYY-MM-DD","volumePercent":70,"intensity":5,"phase":"PP2","reason":"..."},{"kind":"priority","eventId":"...","priority":"minor","reason":"..."},{"kind":"note","text":"..."}]}
Leave out fields you do not want to change.

Plan and logs:
${JSON.stringify(data)}`;
}
function cleanProposals(raw, a, P, bi) {
  const R = reviewWindow(P, bi),
    weeks = new Set(P.W.slice(R.first, R.last + 1).map(w => iso(w.start))),
    TI = { minor: "small", major: "major", key: "key", peak: "peak" },
    ticked = new Set(P.evs.filter(e => e.type === "comp" && !e.training).map(e => e.id)),
    out = [];
  (Array.isArray(raw && raw.proposals) ? raw.proposals : []).slice(0, 5).forEach(p => {
    if (!p || typeof p !== "object") return;
    if (p.kind === "week" && weeks.has(p.week)) {
      const c = {};
      if (p.volumePercent != null && isFinite(+p.volumePercent)) c.load = clamp(Math.round(+p.volumePercent), 0, 110);
      if (p.intensity != null && isFinite(+p.intensity)) c.inten = clamp(Math.round(+p.intensity), 1, 10);
      if (["PP1", "PP2", "COMP", "AREC"].includes(p.phase)) c.phase = p.phase;
      if (Object.keys(c).length) out.push({ id: uid(), kind: "week", week: p.week, c, reason: String(p.reason || "").slice(0, 300) });
    } else if (p.kind === "priority" && ticked.has(p.eventId) && TI[p.priority]) {
      out.push({ id: uid(), kind: "priority", eventId: p.eventId, tier: TI[p.priority], reason: String(p.reason || "").slice(0, 300) });
    } else if (p.kind === "note" && p.text) out.push({ id: uid(), kind: "note", text: String(p.text).slice(0, 400) });
  });
  return out;
}
function reviewHtml(a, P) {
  const R = st.review;
  if (!R || R.aid !== st.cur || R.bkey !== iso(P.W[P.blocks[st.sel].start].start)) return "";
  if (R.status === "thinking") return `<div class="review"><span class="lab">Review by Claude</span><p style="margin:4px 0 0">Thinking… This can take up to a minute. <button class="link" data-act="review-stop">Stop</button></p></div>`;
  if (R.status === "error") return `<div class="review"><span class="lab">Review by Claude</span><p style="margin:4px 0 0">${esc(R.msg)}</p></div>`;
  const ev = id => P.evs.find(e => e.id === id),
    lab = p =>
      p.kind === "week"
        ? `Week of ${fmt(parse(p.week))}: ${[p.c.phase ? PH[p.c.phase].n : "", p.c.load != null ? `volume ${p.c.load}%` : "", p.c.inten != null ? `intensity ${p.c.inten}/10` : ""].filter(Boolean).join(", ")}`
        : p.kind === "priority"
          ? `${esc((ev(p.eventId) || {}).name || "Competition")}: make it ${tierLab[p.tier].toLowerCase()}`
          : "Note";
  return `<div class="review"><span class="lab">Review by Claude</span><p style="margin:4px 0 6px">${esc(R.summary || "")}</p>
    ${R.proposals.length ? `<ul class="sugg">${R.proposals.map(p => `<li class="${p.done ? "good" : ""}"><strong>${lab(p)}</strong>${p.kind === "note" ? `<div>${esc(p.text)}</div>` : `<div>${esc(p.reason)}</div>`}
      <div class="row" style="margin-top:6px;gap:6px">${p.done ? `<span class="pill rate-ok">${p.done}</span>` : `${p.kind === "note" ? "" : `<button data-act="rv-accept" data-id="${p.id}">Accept</button>`}<button class="link" data-act="rv-dismiss" data-id="${p.id}">Dismiss</button>`}</div></li>`).join("")}</ul>` : `<p class="muted" style="margin:0">No changes proposed.</p>`}
    <p class="muted" style="margin:6px 0 0;font-size:12px">Accepted week changes become hand adjustments, which you can undo in the week card. Priority changes apply to ${esc(a.name)} only.</p></div>`;
}
/* the week's coaching notes as headed blocks: This week, Range, Finals, Physical, Mental, Tactics, Rest */
function focusHtml(w, P) {
  const items = focus(w, P);
  return `<div class="fx">${FOCUS_GROUPS.map(([g, h]) => {
    const l = items.filter(x => x.g === g);
    return l.length
      ? `<div class="fxb fx-${g}"><div class="lab">${h}</div>${l.length === 1 ? `<p>${esc(l[0].t)}</p>` : `<ul>${l.map(x => `<li>${esc(x.t)}</li>`).join("")}</ul>`}</div>`
      : "";
  }).join("")}</div>`;
}
function blockHtml(P) {
  const b = P.blocks[st.sel],
    ws = P.W.slice(b.start, b.start + b.len),
    nm = b.phase === "RECV" ? "Recovery" : PH[b.phase].n;
  const cats = [
    ["t10", "c10", "10m range"],
    ["t50", "c50", "50m 3P range"],
    ["phys", "cphys", "Physical"],
    ["mental", "cment", "Mental"],
    ["rec", "crec", "Recovery"],
  ];
  return `<section class="panel"><div class="hd"><div><div class="lab">Block ${st.sel + 1} of ${P.blocks.length} · ${esc(b.pattern)}</div><h2>${nm}, weeks ${b.start + 1}–${b.start + b.len} <span class="muted" style="font-weight:500">${range(ws[0].start, ws[ws.length - 1].start + 6 * DAY)}</span></h2></div>
  <div class="row">${Object.keys(P.adj).length && st.role === "coach" ? `<button class="link" data-act="adj-clear-all">Clear all ${Object.keys(P.adj).length} hand adjustments</button>` : ""}${st.sample && st.role === "coach" ? `<button data-act="review"${st.review && st.review.status === "thinking" ? " disabled" : ""}>Review this block with Claude</button>` : ""}<button data-act="blk-prev"${st.sel === 0 ? " disabled" : ""}>← Previous block</button><button data-act="blk-next"${st.sel === P.blocks.length - 1 ? " disabled" : ""}>Next block →</button></div></div>
  ${st.role === "coach" ? reviewHtml(cur(), P) : ""}
  ${
    P.fg
      ? (() => {
          const s0 = P.W[b.start].start,
            e0 = P.W[b.start + b.len - 1].start + 6 * DAY,
            Ms = P.fg.months.filter(M => M.m <= e0 && mAdd(M.m, 1) > s0);
          return Ms.length
            ? `<div class="bgoal"><span class="lab">Pathway towards ${esc(P.fg.b.comp)} · ${esc(P.fg.E.label)}</span>${Ms.map(M => `<div><strong>${mLab(M.m)}</strong> · ${pathLine(M, P.fg)}${M.comps.length ? ` · <span class="muted">${M.comps.map(x => esc(x.comp)).join(", ")}</span>` : ""}</div>`).join("")}</div>`
            : "";
        })()
      : ""
  }
  <div class="weeks">${ws
    .map(w => {
      const tot = cats.reduce((s, c) => s + w.split[c[0]], 0) || 1;
      const nS = ((cur().sessions || {})[iso(w.start)] || []).length,
        isOpen = st.wk === iso(w.start);
      return `<article class="wkc ${w.phase}${isOpen ? " open" : ""}">
    <div><div class="lab num">Week ${w.i + 1} · ${range(w.start, w.start + 6 * DAY)}</div>
    <button class="${isOpen ? "pri " : ""}wkbtn" data-act="${isOpen ? "wk-close" : "wk-open"}" data-id="${iso(w.start)}" aria-expanded="${isOpen}">${isOpen ? "Close sessions" : nS ? `Sessions · ${nS} planned` : "Plan sessions"}</button><div class="row" style="gap:5px;margin-top:4px"><span class="pill">${esc(w.type)}</span>${w.manual ? `<span class="pill" style="border-color:var(--accent);color:var(--accent)">Hand-set</span>` : ""}${w.tags.map(t => `<span class="pill">${esc(t)}</span>`).join("")}</div></div>
    ${w.events.length ? `<div class="evl">${w.events.map(e => `<div><strong>${e.type === "camp" ? "Camp" : e.type === "hol" ? "Holiday" : tierLab[e.tier]}${e.type === "comp" && e.tier === "peak" ? " ★" : ""}:</strong> ${esc(e.name)} <span class="muted">${e.type === "comp" ? discLab[e.disc] + " · " : ""}${range(e.st, e.en)}</span></div>`).join("")}</div>` : ""}
    <div class="stats num"><div><span class="lab">Volume</span><b>${w.load}%</b></div><div><span class="lab">Hours</span><b>${hrs(w.hours)}</b></div><div><span class="lab">Intensity</span><b>${w.inten}/10</b></div></div>
    <div class="bar">${cats.map(c => `<span style="width:${(w.split[c[0]] / tot) * 100}%;background:var(--${c[1]})"></span>`).join("")}</div>
    <div class="split num">${cats
      .filter(c => w.split[c[0]] > 0.2)
      .map(
        c =>
          `<span><i style="background:var(--${c[1]})"></i>${c[2]}</span><span>${hrs(w.split[c[0]])} h</span>`,
      )
      .join("")}</div>
    ${w.shots10 + w.shots50 > 0 ? `<div class="shots num"><span class="lab">Suggested live shots</span><div>${w.shots10 ? `10m <b>${w.shots10}</b>` : ""}${w.shots10 && w.shots50 ? " · " : ""}${w.shots50 ? `50m <b>${w.shots50}</b> <span class="muted">(K ${w.pos.k} · P ${w.pos.p} · S ${w.pos.s})</span>` : ""}</div><div class="muted">Load about ${w.units.toLocaleString("en-GB")} units (shots × intensity)</div></div>` : ""}
    ${w.split.fin >= 0.25 ? `<div class="shots num"><span class="lab">Finals training</span><div>About <b>${hrs(w.split.fin)} h</b> of the range time, roughly ${Math.max(1, Math.round(w.split.fin / 0.75))} full final${Math.round(w.split.fin / 0.75) > 1 ? "s" : ""}</div></div>` : ""}
    ${focusHtml(w, P)}
    ${logAdjHtml(w)}
    ${w.start <= Date.now() ? logHtml(w, P) : `<label class="f">Note for this week<textarea id="wn-${iso(w.start)}" data-wn="${iso(w.start)}" rows="2" maxlength="600" placeholder="Anything to remember about this week">${esc((P.wn || {})[iso(w.start)] || "")}</textarea></label>`}
    ${(k => {
      if (st.role !== "coach") return "";
      const j = P.adj[k] || {},
        o = (v, l) => `<option value="${v}"${(j.phase || "auto") === v ? " selected" : ""}>${l}</option>`;
      return `<details class="adj"${P.adj[k] ? " open" : ""}><summary>Adjust this week${P.adj[k] ? " · adjusted by hand" : ""}</summary><div class="row">
      <label class="f">Phase<select id="aj-p-${k}" data-adj="${k}|phase">${o("auto", "As planned")}${Object.keys(
        PH,
      )
        .map(x => o(x, PH[x].n))
        .join("")}</select></label>
      <label class="f">Volume %<input id="aj-l-${k}" type="number" min="0" max="110" step="5" placeholder="${w.autoLoad}" data-adj="${k}|load" value="${j.load != null ? esc(j.load) : ""}"></label>
      <label class="f">Intensity<input id="aj-i-${k}" type="number" min="1" max="10" placeholder="${w.autoInten}" data-adj="${k}|inten" value="${j.inten != null ? esc(j.inten) : ""}"></label>
      ${P.adj[k] ? `<button class="link" data-act="adj-clear" data-id="${k}">Back to the plan</button>` : ""}</div></details>`;
    })(iso(w.start))}</article>`;
    })
    .join("")}</div>${weekPlanHtml(cur(), P)}</section>`;
}
/* ---------- week planner: individual sessions inside one week ---------- */
const AMPM = { am: "AM", pm: "PM" };
const isRange = t => t === "t10" || t === "t50";
/* hours to the nearest quarter, written as a coach would: 2 h 15, 45 min */
const hm = v => {
  const m = Math.round(((+v || 0) * 60) / 15) * 15,
    h = Math.floor(m / 60),
    r = m % 60;
  return h ? `${h} h${r ? " " + r : ""}` : `${r} min`;
};
function weekPlanHtml(a, P) {
  const w = st.wk && P.W.find(x => iso(x.start) === st.wk);
  if (!w || w.block !== st.sel) return "";
  const k = st.wk,
    list = (a.sessions || {})[k] || [],
    T = sessTotals(list),
    days = weekDays(w),
    prev = P.W[w.i - 1],
    next = P.W[w.i + 1],
    others = Object.keys(a.sessions || {})
      .filter(x => x !== k && (a.sessions[x] || []).length)
      .sort(),
    wkLab = x => {
      const ww = P.W.find(y => iso(y.start) === x);
      return `${ww ? "Week " + (ww.i + 1) + " · " : ""}${range(parse(x), parse(x) + 6 * DAY)} (${a.sessions[x].length})`;
    };
  /* planned against the week's targets */
  const rows = [
    ...Object.keys(SESS).map(t => [SESS[t].n, T[t], w.split[t], "h"]),
    ["Total hours", T.hours, w.hours, "h"],
    ["10m shots", T.shots10, w.shots10, "s"],
    ["Kneeling shots", T.k, w.pos.k, "s"],
    ["Prone shots", T.p, w.pos.p, "s"],
    ["Standing shots", T.s, w.pos.s, "s"],
    ["Finals", T.fin, finTarget(w), "n"],
  ].filter(r => r[1] > 0 || r[2] > 0.2);
  const off = r =>
      r[3] === "h" ? Math.abs(r[1] - r[2]) >= 0.5 : r[3] === "s" ? Math.abs(r[1] - r[2]) > Math.max(25, r[2] * 0.1) : r[1] !== r[2],
    fmtv = (v, u) => (u === "h" ? hm(v) : String(Math.round(v)));
  const ask = st.wkAsk
    ? `<div class="wpask" role="alert">${
        st.wkAsk === "draft"
          ? `Replace the ${list.length} session${list.length === 1 ? "" : "s"} in this week with a fresh draft?`
          : st.wkAsk === "copy"
            ? `Replace the ${list.length} session${list.length === 1 ? "" : "s"} in this week with the ones from ${esc(wkLab(st.copyFrom))}?`
            : `Delete all ${list.length} session${list.length === 1 ? "" : "s"} in this week?`
      } <button class="pri" data-act="wk-yes">${st.wkAsk === "clear" ? "Delete them" : "Replace"}</button><button data-act="wk-no">Cancel</button></div>`
    : "";
  const chip = x =>
    `<button class="ses${st.ses === x.id ? " on" : ""}" style="--sc:var(--${(SESS[x.type] || SESS.rec).c})" data-act="ses-edit" data-id="${esc(x.id)}" aria-expanded="${st.ses === x.id}">
      <b>${esc((SESS[x.type] || SESS.rec).s)} · ${hm(x.dur)}</b>${x.type === "t10" && +x.shots ? ` <span class="num">${+x.shots} shots</span>` : ""}${x.type === "t50" && +x.k + +x.p + +x.s ? ` <span class="num">K ${+x.k || 0} · P ${+x.p || 0} · S ${+x.s || 0}</span>` : ""}${x.fin && isRange(x.type) ? ` <span class="pill">Final</span>` : ""}
      ${x.loc || x.note ? `<span class="muted">${esc([x.loc, x.note].filter(Boolean).join(" · "))}</span>` : ""}</button>`;
  const editor = x => {
    const f = (fld, lab, inner) => `<label class="f">${lab}${inner}</label>`,
      id = esc(x.id),
      num = (fld, lab, step, max) =>
        f(fld, lab, `<input id="se-${id}-${fld}" type="number" min="0" max="${max}" step="${step}" data-ses="${id}|${fld}" value="${x[fld] != null && x[fld] !== "" ? esc(x[fld]) : ""}">`);
    return `<div class="sesed" id="sesed"><div class="row">
      ${f("type", "Type", `<select id="se-${id}-type" data-ses="${id}|type">${Object.keys(SESS).map(t => `<option value="${t}"${x.type === t ? " selected" : ""}>${SESS[t].n}</option>`).join("")}</select>`)}
      ${f("day", "Day", `<select id="se-${id}-day" data-ses="${id}|day">${days.map(d => `<option value="${d.i}"${+x.day === d.i ? " selected" : ""}>${d.n} ${fmt(d.d)}${d.kind ? (d.kind === "hol" ? " (holiday)" : " (competition)") : ""}</option>`).join("")}</select>`)}
      ${f("ampm", "Time", `<select id="se-${id}-ampm" data-ses="${id}|ampm">${Object.keys(AMPM).map(t => `<option value="${t}"${x.ampm === t ? " selected" : ""}>${AMPM[t]}</option>`).join("")}</select>`)}
      ${num("dur", "Hours", 0.25, 8)}
      ${x.type === "t10" ? num("shots", "Shots", 5, 1000) : ""}
      ${x.type === "t50" ? num("k", "Kneeling shots", 5, 500) + num("p", "Prone shots", 5, 500) + num("s", "Standing shots", 5, 500) : ""}
      ${isRange(x.type) ? `<label class="chk"><input type="checkbox" id="se-${id}-fin" data-ses="${id}|fin"${x.fin ? " checked" : ""}> Includes a final</label>` : ""}
      ${f("loc", "Location", `<input id="se-${id}-loc" maxlength="60" data-ses="${id}|loc" value="${esc(x.loc || "")}" placeholder="e.g. Magglingen">`)}
    </div>
    <label class="f" style="margin-top:6px">Content<textarea id="se-${id}-note" rows="2" maxlength="400" data-ses="${id}|note" placeholder="What the session is for and how it runs">${esc(x.note || "")}</textarea></label>
    <div class="row" style="margin-top:6px"><button data-act="ses-done">Done</button><button data-act="ses-dup" data-id="${id}">Duplicate</button><button class="link" data-act="ses-del" data-id="${id}">Delete session</button></div></div>`;
  };
  const dayRow = d => {
    const ds = list.filter(x => +x.day === d.i),
      ed = ds.find(x => x.id === st.ses),
      blocked = d.kind
        ? `<div class="wpblk">${d.kind === "hol" ? "Holiday" : "Competition"}: ${esc(d.ev.name)}. Nothing is planned on this day.${ds.length ? ` <strong class="warnt">${ds.length} session${ds.length === 1 ? " is" : "s are"} still on it.</strong>` : ""}</div>`
        : "",
      slot = ap =>
        `<div class="wpslot"><span class="lab">${AMPM[ap]}</span>${ds
          .filter(x => (x.ampm || "am") === ap)
          .map(chip)
          .join("")}${d.kind ? "" : `<button class="link" data-act="ses-add" data-id="${d.i}|${ap}" aria-label="Add a ${AMPM[ap]} session on ${d.n}">+ Add</button>`}</div>`;
    return `<div class="wpday${d.kind ? " blk" : ""}"><div class="wpd"><b>${d.n}</b> <span class="num">${fmt(d.d)}</span>${d.camp ? `<div class="muted">Camp: ${esc(d.camp.name)}</div>` : ""}</div>
      ${d.kind && !ds.length ? blocked : `${blocked}${slot("am")}${slot("pm")}`}${ed ? editor(ed) : ""}</div>`;
  };
  return `<div class="wplan" id="wplan">
    <div class="hd"><div><div class="lab">Sessions · ${esc(w.type)} · ${PH[w.phase] ? PH[w.phase].n : w.phase}</div><h3>Week ${w.i + 1}, ${range(w.start, w.start + 6 * DAY)}</h3></div>
    <div class="row">${prev ? `<button data-act="wk-step" data-id="${iso(prev.start)}">← Week ${prev.i + 1}</button>` : ""}${next ? `<button data-act="wk-step" data-id="${iso(next.start)}">Week ${next.i + 1} →</button>` : ""}<button data-act="wk-close">Close</button></div></div>
    <div class="row wptools"><button class="pri" data-act="wk-draft"${w.hours > 0 ? "" : " disabled"}>${list.length ? "Redraft this week" : "Draft this week"}</button>
      ${others.length ? `<label class="f">Copy sessions from<select id="wk-copyfrom"><option value="">Choose a week</option>${others.map(x => `<option value="${x}"${st.copyFrom === x ? " selected" : ""}>${esc(wkLab(x))}</option>`).join("")}</select></label>${st.copyFrom ? `<button data-act="wk-copy">Copy</button>` : ""}` : ""}
      ${list.length ? `<button class="link" data-act="wk-clear">Clear this week</button>` : ""}</div>
    ${w.hours > 0 ? "" : `<p class="muted" style="margin:6px 0 0">No training hours are planned this week, so there is nothing to draft. You can still add sessions by hand.</p>`}
    ${ask}
    <div class="wpgrid"><div class="wpdays">${days.map(dayRow).join("")}</div>
    <table class="wptot"><caption class="lab">Planned against this week's targets</caption><thead><tr><th></th><th class="num">Planned</th><th class="num">Target</th></tr></thead><tbody>${rows
      .map(r => `<tr${off(r) ? ' class="off"' : ""}><th>${r[0]}</th><td class="num">${fmtv(r[1], r[3])}</td><td class="num">${fmtv(r[2], r[3])}</td></tr>`)
      .join("")}</tbody></table></div>
    <p class="muted" style="margin:6px 0 0;font-size:12px">Sessions do not change the week's targets: those come from the plan and your adjustments above. Rows in orange are more than half an hour, or more than 10% of the shots (at least 25), away from the target.</p>
  </div>`;
}
function eventsHtml(a) {
  const ed = st.editing ? st.cal.events.find(e => e.id === st.editing) : null,
    v = ed || { type: "comp", disc: "10m", tier: "major" },
    pk = a.picks || {};
  const opt = (val, lab, c) => `<option value="${val}"${c === val ? " selected" : ""}>${lab}</option>`;
  const list = st.cal.events.slice().sort((x, y) => parse(x.start) - parse(y.start)),
    nOn = list.filter(e => pk[e.id] && pk[e.id].on).length,
    others = Object.keys(st.athletes).length > 1;
  const sugg = st.role === "coach" ? feedMatches() : [],
    coach = st.role === "coach";
  return `<section class="panel"><div class="hd"><h2>Competitions, camps and holidays</h2>${sugg.length ? `<button class="link" data-act="fc-link">Link ${sugg.length} competition${sugg.length === 1 ? "" : "s"} to the ISSF calendar</button>` : ""}<span class="muted">${list.length} in the shared calendar · ${nOn} in ${esc(a.name)}'s plan</span></div>
  ${coach ? `<form id="ev-form" class="row" style="margin-bottom:12px">
    <label class="f" style="flex:1 1 180px">Name<input id="ev-name" required maxlength="80" value="${esc(v.name || "")}"></label>
    <label class="f">Type<select id="ev-type">${opt("comp", "Competition", v.training ? "training" : v.type)}${opt("training", "Training match", v.training ? "training" : v.type)}${opt("camp", "Training camp", v.type)}${opt("hol", "Holiday (no training)", v.type)}</select></label>
    <label class="f" id="ev-disc-w">Discipline<select id="ev-disc">${opt("10m", "10m", v.disc)}${opt("50m", "50m 3P", v.disc)}${opt("both", "Both", v.disc)}</select></label>
    <label class="f" id="ev-tier-w">Usual priority<select id="ev-tier">${opt("small", "Minor", v.tier)}${opt("major", "Major", v.tier)}${opt("key", "Key", v.tier)}${opt("peak", "Peak", v.tier)}</select></label>
    <label class="f">First day<input id="ev-start" type="date" required value="${esc(v.start || "")}"></label>
    ${st.feed ? `<label class="f" id="ev-fc-w" style="flex:1 1 220px">ISSF competition<select id="ev-fc"><option value="">Not an ISSF competition</option>${st.feed.meta.calendar.map(c => `<option value="${c.id}"${v.feedComp === c.id ? " selected" : ""}>${esc(c.name)}, ${esc(c.city)} (${fmt(parse(c.start))})</option>`).join("")}</select></label>` : ""}
    <label class="f">Last day<input id="ev-end" type="date" min="${esc(v.start || "")}" value="${esc(v.end || "")}"></label>
    ${!ed && others ? `<label class="chk"><input id="ev-all" type="checkbox"> Switch on for every athlete</label>` : ""}
    <button class="pri" type="submit">${ed ? "Save for all athletes" : "Add to calendar"}</button>${ed ? `<button type="button" data-act="ev-cancel">Cancel</button>` : ""}
  </form>` : ""}
  ${
    list.length
      ? `<div class="tw"><table><thead><tr><th>In plan</th><th>Dates</th><th>Event</th><th>Priority for ${esc(a.name)}</th><th>Taper</th>${coach ? "<th></th>" : ""}</tr></thead><tbody>${list
          .map(e => {
            const k = pk[e.id] || {},
              on = !!k.on,
              tier = k.tier || e.tier;
            return `<tr class="${on ? "" : "off"}">
    <td><input type="checkbox" id="pk-${e.id}" data-pick="${e.id}"${on ? " checked" : ""}${!coach && e.type !== "comp" ? " disabled" : ""} aria-label="Include ${esc(e.name)} in this athlete's plan"></td>
    <td class="num" style="white-space:nowrap">${range(parse(e.start), parse(e.end || e.start))}</td><td>${esc(e.name)}${e.type === "comp" ? ` <span class="muted">· ${discLab[e.disc]}</span>` : ""}${e.feedComp && st.feed ? (c => (c ? `<div class="muted" style="font-size:12px">ISSF: ${esc(c.name)}, ${esc(c.city)}</div>` : `<div class="muted" style="font-size:12px">ISSF competition no longer in the feed</div>`))(st.feed.meta.calendar.find(c => c.id === e.feedComp)) : ""}</td>
    <td>${e.type === "camp" ? "Camp" : e.type === "hol" ? "Holiday, no training" : e.training ? "Training match" : on ? `<select id="pt-${e.id}" data-ptier="${e.id}" aria-label="Priority">${opt("small", "Minor", tier)}${opt("major", "Major", tier)}${opt("key", "Key ◆", tier)}${opt("peak", "Peak ★", tier)}</select>` : `<span class="muted">${tierLab[e.tier]} usually</span>`}</td>
    <td style="white-space:nowrap">${e.type === "comp" && on && tier === "peak" ? `<input id="pp-${e.id}" type="number" min="1" max="4" style="width:58px" placeholder="${settingsOf(a).taperPeak}" data-ptaper="${e.id}" value="${esc(k.taper || "")}" aria-label="Taper weeks"> wk` : ""}</td>
    ${coach ? `<td class="act">${st.confirmDel === e.id ? `<button class="link danger" data-act="ev-del2" data-id="${e.id}">Delete for all athletes</button><button class="link" data-act="del-cancel">Keep</button>` : `<button class="link" data-act="ev-edit" data-id="${e.id}">Edit</button><button class="link danger" data-act="ev-del" data-id="${e.id}">Delete</button>`}</td>` : ""}</tr>`;
          })
          .join("")}</tbody></table></div>
  <p class="muted" style="margin:8px 0 0;font-size:12.5px">${coach ? `The calendar is shared by all athletes. The tick, priority and taper apply to ${esc(a.name)} only. Editing or deleting an event changes it for everyone.` : "The calendar comes from your coach. The tick, priority and taper change your plan only; camps and holidays are set by your coach. Ask your coach to add a competition that is missing."}</p>`
      : `<p class="muted" style="margin:0">The shared calendar is empty. Add each competition and camp once, then tick the ones each athlete is doing. Start with the peak events (World Championships, continental championships), then World Cups, domestic matches, fixed camps and holidays.</p>`
  }</section>`;
}
function settingsHtml(P) {
  const S = P.S,
    n = (id, k, lab, min, max) =>
      `<label class="f">${lab}<input id="${id}" type="number" min="${min}" max="${max}" data-s="${k}" value="${S[k]}"></label>`;
  return `<section class="panel"><div class="hd"><h2>Planning rules</h2><button class="link" data-act="set-reset">Reset to defaults</button></div>
  <div class="row" style="margin-bottom:12px">${n("s-taper", "taperPeak", "Peak taper (weeks)", 1, 4)}${n("s-major", "majorTaperDays", "Major mini-taper (days)", 0, 7)}${n("s-rec", "recoveryWeeks", "Recovery after a peak (weeks)", 1, 4)}${n("s-gap", "clusterGap", "Peaks within this many weeks share one competition phase", 0, 8)}${n("s-pp2", "pp2Max", "Longest Preparation 2 (weeks)", 6, 12)}</div>
  <h3 style="margin-bottom:4px">Finals training, as % of range time</h3>
  <div class="row" style="margin-bottom:12px">${[
    ["pp1", "Preparation 1"],
    ["pp2", "Preparation 2"],
    ["pre", "Run-in to a competition"],
    ["taper", "Taper"],
  ]
    .map(
      x =>
        `<label class="f">${x[1]}<input id="fn-${x[0]}" type="number" min="0" max="100" data-fin="${x[0]}" value="${S.finals[x[0]]}"></label>`,
    )
    .join("")}</div>
  <h3 style="margin-bottom:4px">Suggested shots</h3>
  <div class="row" style="margin-bottom:12px">${[
    ["r10", "Air rifle shots per hour", 5, 150],
    ["rk", "Kneeling shots per hour", 5, 150],
    ["rp", "Prone shots per hour", 5, 150],
    ["rs", "Standing shots per hour", 5, 150],
    ["k", "50m time kneeling %", 0, 100],
    ["p", "50m time prone %", 0, 100],
    ["s", "50m time standing %", 0, 100],
  ]
    .map(
      x =>
        `<label class="f">${x[1]}<input id="sh-${x[0]}" type="number" min="${x[2]}" max="${x[3]}" data-sh="${x[0]}" value="${S.shots[x[0]]}"></label>`,
    )
    .join("")}</div>
  <h3 style="margin-bottom:4px">How each phase's hours are divided (%)</h3>
  <div class="tw"><table class="num"><thead><tr><th>Phase</th><th>Range</th><th>Physical</th><th>Mental</th><th>Recovery</th></tr></thead><tbody>${Object.keys(
    PH,
  )
    .filter(p => p !== "HOL")
    .map(
      p =>
        `<tr><td>${PH[p].n}</td>${["sport", "phys", "mental", "rec"].map(k => `<td><input id="sp-${p}-${k}" type="number" min="0" max="100" style="width:62px" data-sp="${p}.${k}" value="${S.split[p][k]}"></td>`).join("")}</tr>`,
    )
    .join("")}</tbody></table></div>
  <p class="muted" style="margin:8px 0 0;font-size:12.5px">Rows are rescaled if they do not add up to 100. Each peak event can have its own taper length in the athlete's event list.</p></section>`;
}
function methodHtml() {
  return `<section class="panel"><details><summary>How the plan is built</summary><div class="prose">
  <p>The season is planned backwards from the peak events, following the Swiss Shooting / J+S training-planning course and the wider periodisation literature.</p>
  <ul>
   <li><strong>Phases.</strong> Each peak (or group of peaks close together) gets its own cycle: Preparation 1 (general: fitness, technique elements, equipment tests), Preparation 2 (specific: rhythm, full courses, match script), Competition (taper plus the event), then Recovery and Active recovery. Two peaks months apart give the double periodisation typical of an indoor 10m and outdoor 50m year.</li>
   <li><strong>4-week blocks.</strong> Preparation blocks load progressively and end with a deload week (3:1). The last block before a peak is regressive: an overreach week early, then stepping down into the taper.</li>
   <li><strong>Taper.</strong> Default 2 weeks, with volume falling to roughly half while intensity and session frequency are held. This matches the taper meta-analysis by Bosquet et al. (2007) and Mujika and Padilla (2003). The planner shortens the taper or the recovery itself when events are too close and tells you when it has.</li>
   <li><strong>Priorities.</strong> Peak events shape the phases. Key events sit between major and peak: the 3 weeks before become specific preparation with a one-week taper, the week after is an easy week, and the plan then returns to the build for the next peak without a recovery block. A key event within four weeks of the season start is prepared by holding form from the previous season. A key event that runs into a peak's taper, a recovery period or another key event cannot have its own block; it gets a short taper inside the build instead (a lighter week before it, a deeper cut in the event week, easy days after), and a note explains why. Major events get a mini-taper of a few days inside the build. Minor events are trained through and used as competition simulations.</li>
   <li><strong>Suggested shots.</strong> Range hours are converted to live shots with the hourly rates under Planning rules, which include breaks: one rate for air rifle and one each for kneeling, prone and standing. 50m range time is divided between the three positions by the percentages there, so a position with a faster rate gives more shots for the same time. Preparation 1 counts 20% fewer live shots because more of the range time is dry firing and holding. These are starting values to test against what your athletes actually shoot.</li>
   <li><strong>Suggestions.</strong> The planner looks for events that work against the plan and proposes leaving them out or lowering their priority for that athlete: competitions or camps in a recovery period, a major in the heaviest build week or the last week of a taper, a match in the other discipline close to a single-discipline peak, three or more competitions inside four weeks of a build, and peaks too close together. An event with two or more of these problems is called out as really not fitting. Key events are never suggested for removal. It also points out good places for a marker competition: a lighter week that closes a training block, with no other competition within three weeks either side.</li>
   <li><strong>Finals training.</strong> A share of range time is set aside for finals in every training phase, and it rises in the run-in to a competition: any week with a major, key or peak event in the next two weeks, and the last build block before a peak. Working on finals in the build-up takes attention off qualification scores while building resilience and familiarity with the format. The shares are under Planning rules.</li>
   <li><strong>Athlete details.</strong> Stronger discipline moves 10% of Preparation 1 range time to the weaker one. Seasons are date windows on the same calendar, so starting a new season keeps the old one viewable with its goals, notes, hand adjustments and results.</li>
   <li><strong>Goals and pathway.</strong> Goals use the Olympic Rifle Rankings feed with the formulas in its README: projected level at the target = level now + trend × 1.5 × (1 − e<sup>−h/1.5</sup>) + the venue's usual difference, where h is the years ahead. The chance of the final is Φ((projected − cut) / √(SD² + cut scatter²)), and the level needed is the cut plus z × the same spread, with z 0, 0.524 or 1.036 for 50, 70 or 85% confidence. Medals use the final chance × the athlete's conversion rate in air rifle and 3P, and the 3rd-best line in prone; the level needed for a medal uses the 3rd-best line. A start date before the feed date uses the level now. Monthly milestones run in a straight line from that level to the needed level less the venue difference, one month before the competition.</li>
   <li><strong>Results.</strong> ISSF qualification scores come in from the rankings feed for competitions linked to the ISSF calendar, or named after the city they were shot in, together with the qualification rank. Other competitions are entered by hand.</li>
   <li><strong>Hand adjustments.</strong> Any week's phase, volume or intensity can be set by hand in its week card. Adjusted weeks stay as you set them when events change, and can be returned to the plan one at a time or all together.</li>
   <li><strong>Competition days.</strong> No training is planned on the days of a competition, whatever its priority. The week's hours shrink in proportion to the days left, and a week that is all competition (or all but one day) has no training hours at all. The plan covers the build-up before each competition and the recovery after it.</li>
   <li><strong>Holidays.</strong> A week with five or more holiday days is a holiday week, shown as its own phase. It has no training and does not count towards the preparation phases: Preparation 1 and 2 are worked out from the training weeks only, so a holiday no longer uses up general preparation. Holiday days carry no training: the week's hours shrink in proportion, a week of five or more days off becomes a holiday week, and the following week is capped so the athlete eases back in. Holidays are flagged when they land in a taper, a competition phase, the last build block before a peak, or on top of a camp or competition. The recovery period after a peak is the best place for them.</li>
   <li><strong>Volume and intensity.</strong> Volume is a percentage of the athlete's heaviest week. Intensity is the course's 1–10 mental-intensity scale (training conditions 1–3, competition 8–10). Weekly load in the course's units is shots multiplied by that intensity.</li>
   <li><strong>10m and 50m share.</strong> Range time leans towards the discipline of the next peak, more strongly as it approaches, and evens out when the peak covers both.</li>
  </ul>
  <p class="muted">The hour splits between range, physical, mental and recovery work are starting values to adjust under Planning rules. Sources: Haidn, Weineck and Haidn-Tschalova (2021); Weineck (2014); Issurin (2010) on block periodisation; Bosquet et al. (2007); Mujika and Padilla (2003).</p></div></details></section>`;
}

/* ================= events ================= */
/* calendar events whose dates overlap a feed competition and whose name mentions its city */
function feedMatches() {
  if (!st.feed) return [];
  const C = st.feed.meta.calendar,
    out = [];
  st.cal.events.forEach(e => {
    if (e.type !== "comp" || e.training || e.feedComp || !e.start) return;
    const s = parse(e.start),
      en = parse(e.end || e.start),
      nm = e.name.toLowerCase();
    const c = C.find(
      c =>
        parse(c.start) <= en + DAY &&
        parse(c.end) >= s - DAY &&
        (c.ranges === "all" || e.disc === "both" || c.ranges === e.disc) &&
        nm.includes(c.city.toLowerCase().slice(0, 4)),
    );
    if (c) out.push({ e, c });
  });
  return out;
}
function bestFeedComp(s, en, disc) {
  if (!st.feed || !s) return "";
  const a = parse(s),
    b = parse(en || s),
    C = st.feed.meta.calendar.filter(
      c =>
        parse(c.start) <= b + DAY &&
        parse(c.end) >= a - DAY &&
        (c.ranges === "all" || disc === "both" || c.ranges === disc),
    );
  return C.length ? C[0].id : "";
}
function syncEvForm() {
  const t = $("ev-type"),
    ti = $("ev-tier");
  if (!t) return;
  const v = t.value,
    comp = v === "comp",
    d = $("ev-disc").value;
  $("ev-disc-w").hidden = !(comp || v === "training");
  $("ev-tier-w").hidden = !comp;
  if ($("ev-fc-w")) $("ev-fc-w").hidden = !comp;
  const s0 = $("ev-start"),
    e0 = $("ev-end");
  if (s0 && e0) e0.min = s0.value || "";
}
/* ---------- week planner actions ---------- */
function setSessions(a, k, list) {
  a.sessions = Object.assign({}, a.sessions);
  if (list.length) a.sessions[k] = list;
  else delete a.sessions[k];
}
function weekAct(act, id) {
  const a = cur();
  if (!a) return;
  const P = plan(view(a)),
    k = act === "wk-open" || act === "wk-step" ? id : st.wk,
    w = P.W.find(x => iso(x.start) === k),
    list = ((a.sessions || {})[k] || []).slice(),
    newId = () => "s" + uid(),
    show = sel => {
      render();
      const el = $(sel);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
  if (act === "wk-close") {
    st.wk = st.ses = st.wkAsk = null;
    render();
    return;
  }
  if (!w) return;
  if (act === "wk-open" || act === "wk-step") {
    st.wk = k;
    st.ses = st.wkAsk = null;
    st.copyFrom = "";
    if (w.block !== st.sel) {
      st.sel = w.block;
      st.jump = true;
    }
    show("wplan");
    return;
  }
  const doIt = what => {
    st.wkAsk = null;
    st.ses = null;
    mutate(b => {
      if (what === "draft") setSessions(b, k, draftWeek(w, P).map(x => Object.assign(x, { id: newId() })));
      else if (what === "copy")
        setSessions(b, k, ((b.sessions || {})[st.copyFrom] || []).map(x => Object.assign({}, x, { id: newId() })));
      else setSessions(b, k, []);
    });
  };
  if (act === "wk-draft" || act === "wk-copy" || act === "wk-clear") {
    const what = act.slice(3);
    if (what === "copy" && !((a.sessions || {})[st.copyFrom] || []).length) return;
    if (list.length) {
      st.wkAsk = what;
      render();
    } else doIt(what);
    return;
  }
  if (act === "wk-yes") {
    if (st.wkAsk) doIt(st.wkAsk);
    return;
  }
  if (act === "wk-no") {
    st.wkAsk = null;
    render();
    return;
  }
  if (act === "ses-edit") {
    st.ses = st.ses === id ? null : id;
    show("sesed");
    return;
  }
  if (act === "ses-done") {
    st.ses = null;
    render();
    return;
  }
  if (act === "ses-add") {
    const [d, ap] = id.split("|"),
      day = weekDays(w)[+d],
      rng = w.split.t10 + w.split.t50 > 0.2,
      x = {
        id: newId(),
        day: +d,
        ampm: ap,
        type: rng ? (w.split.t10 >= w.split.t50 ? "t10" : "t50") : "phys",
        dur: 1,
        loc: day && day.camp ? day.camp.name : "",
        note: "",
      };
    st.ses = x.id;
    st.wkAsk = null;
    const b = cur();
    setSessions(b, k, list.concat([x]));
    persist(st.cur);
    show("sesed");
    return;
  }
  if (act === "ses-dup") {
    const x = list.find(y => y.id === id);
    if (!x) return;
    const c = Object.assign({}, x, { id: newId() });
    st.ses = c.id;
    const b = cur();
    setSessions(b, k, list.concat([c]));
    persist(st.cur);
    show("sesed");
    return;
  }
  if (act === "ses-del") {
    st.ses = null;
    mutate(b => setSessions(b, k, list.filter(y => y.id !== id)));
  }
}
document.addEventListener("click", e => {
  const tl = e.target.closest("#tl");
  if (tl) {
    const r = tl.getBoundingClientRect(),
      x = e.clientX - r.left - +tl.dataset.lw,
      a = cur();
    if (x >= 0 && a) {
      const P = plan(view(a)),
        w = clamp(Math.floor(x / +tl.dataset.cw), 0, P.N - 1);
      st.sel = P.W[w].block;
      render();
    }
    return;
  }
  const mw = e.target.closest("[data-mw]");
  if (mw) {
    const P = plan(view(cur()));
    st.sel = P.W[+mw.dataset.mw].block;
    st.view = "athlete";
    st.jump = true;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const sq = e.target.closest("#sq");
  if (sq && !e.target.closest("[data-act]")) {
    const r = e.target.closest("[data-sq]");
    if (r) {
      const x = e.clientX - sq.getBoundingClientRect().left - +sq.dataset.lw;
      st.cur = r.dataset.sq;
      st.view = "athlete";
      lsSet("rsp-cur", st.cur);
      const P = plan(view(cur())),
        w = Math.floor(x / +sq.dataset.cw) - +r.dataset.off;
      st.sel = x >= 0 && w >= 0 && w < P.N ? P.W[w].block : null;
      render();
      window.scrollTo(0, 0);
    }
    return;
  }
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act,
    id = b.dataset.id;
  if (st.role === "locked" || (st.role === "athlete" && !athAllowed(act))) return;
  if (act === "claim-del") {
    st.claims = st.claims.filter(c => c.id !== id);
    chain = chain.then(() => db.doc("claims/" + id).delete()).catch(() => {});
    render();
    return;
  }
  if (act === "acc-code" || act === "acc-nocode") {
    mutate(a => {
      if (act === "acc-code") a.claim = newCode();
      else delete a.claim;
    });
    processClaims();
    return;
  }
  if (act === "acc-unlink") {
    st.confirmDel = "unlink";
    render();
    return;
  }
  if (act === "acc-unlink2") {
    st.confirmDel = null;
    moveAthlete(st.cur, uid(), false);
    render();
    return;
  }
  if (act === "view") {
    st.view = id;
    render();
    return;
  }
  if (act === "open-ath") {
    st.cur = id;
    st.view = "athlete";
    st.sel = null;
    lsSet("rsp-cur", id);
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (act.startsWith("wk-") || act.startsWith("ses-")) {
    weekAct(act, id);
    return;
  }
  if (act === "log-ign") {
    mutate(a => {
      a.logIgnore = Object.assign({}, a.logIgnore);
      if (a.logIgnore[id]) delete a.logIgnore[id];
      else a.logIgnore[id] = 1;
    });
    return;
  }
  if (act === "review") {
    const a0 = cur(),
      P0 = plan(view(a0));
    P0.fg = mainGoal(a0);
    const bi = st.sel,
      R = { aid: st.cur, bkey: iso(P0.W[P0.blocks[bi].start].start), status: "thinking", ctl: new AbortController() };
    st.review = R;
    render();
    st.sample
      .json(reviewPrompt(a0, P0, bi), { signal: R.ctl.signal, modelTier: "default" })
      .then(
        res => {
          if (st.review !== R) return;
          R.status = "done";
          R.summary = String((res && res.summary) || "").slice(0, 800);
          R.proposals = cleanProposals(res, a0, P0, bi);
          render();
        },
        er => {
          if (st.review !== R) return;
          const c = er && er.code,
            M = {
              cancelled: "Review stopped.",
              not_granted: "Asking Claude was not allowed in this view.",
              rate_limited: "Too many requests just now. Try again in a minute.",
              invalid_json: "Claude's answer could not be read. Try again.",
              prompt_too_large: "There is too much in this block to send. Shorten the week notes and try again.",
            };
          R.status = "error";
          R.msg = M[c] || `Claude could not review the block${c ? " (" + c + ")" : ""}.`;
          render();
        },
      );
    return;
  }
  if (act === "review-stop") {
    if (st.review && st.review.ctl) st.review.ctl.abort();
    return;
  }
  if (act === "rv-dismiss" || act === "rv-accept") {
    const R = st.review,
      p = R && R.proposals && R.proposals.find(x => x.id === id);
    if (!p) return;
    if (act === "rv-dismiss") {
      R.proposals = R.proposals.filter(x => x !== p);
      render();
      return;
    }
    if (p.kind === "week")
      mutate(a => {
        a.adj = Object.assign({}, a.adj);
        a.adj[p.week] = Object.assign({}, a.adj[p.week], p.c);
      });
    else if (p.kind === "priority") {
      const ev = st.cal.events.find(e => e.id === p.eventId);
      mutate(a => {
        const k = (a.picks[p.eventId] = Object.assign({}, a.picks[p.eventId]));
        if (ev && ev.tier === p.tier) delete k.tier;
        else k.tier = p.tier;
        if (p.tier !== "peak") delete k.taper;
      });
    }
    p.done = "Accepted";
    render();
    return;
  }
  if (act === "bk-save") {
    const data = {
      app: "rifle-season-planner",
      version: 1,
      exported: new Date().toISOString(),
      athletes: st.athletes,
      calendar: st.cal,
    };
    st.dl
      .save({
        filename: `rifle-season-planner-backup-${iso(Date.now())}.json`,
        data: JSON.stringify(data, null, 1),
      })
      .then(
        () => {
          st.bkMsg = "Backup saved.";
          render();
        },
        er => {
          st.bkMsg =
            er && er.code === "declined"
              ? "The download was cancelled."
              : `The backup could not be saved${er && er.message ? ": " + er.message : "."}`;
          render();
        },
      );
    return;
  }
  if (act === "bk-cancel") {
    st.restore = null;
    render();
    return;
  }
  if (act === "bk-restore") {
    const d = JSON.parse(JSON.stringify(st.restore.data)),
      before = Object.keys(st.athletes);
    st.restore = null;
    st.athletes = d.athletes;
    st.cal = d.calendar;
    before.concat(Object.keys(d.athletes)).forEach(id => persist(id));
    saveCal();
    st.cur = st.athletes[st.cur] ? st.cur : Object.keys(st.athletes)[0] || null;
    st.sel = null;
    st.bkMsg = "Backup restored.";
    render();
    return;
  }
  if (act === "season-next") {
    st.sel = null;
    mutate(a => {
      const l = seasonsOf(a),
        nx = iso(mondayOf(parse(a.seasonStart)) + (a.weeks || 52) * WEEK),
        x = l.find(q => q.start === nx);
      a.seasons = x ? l : l.concat([{ start: nx, weeks: 52 }]);
      a.seasonStart = nx;
      a.weeks = x ? x.weeks : 52;
    });
    return;
  }
  if (act === "fg-add") {
    const a0 = cur(),
      L = feedEntries(a0);
    if (!L.length) return;
    const x = L.find(y => y.k !== "PR") || L[0],
      h = x.fa.headline && x.E.bench[x.fa.headline.compId] ? x.fa.headline.compId : "";
    mutate(a => {
      a.fgoals = Object.assign({}, a.fgoals);
      const l = (a.fgoals[a.seasonStart] || []).slice();
      l.push({ id: uid(), ev: x.key, compId: h, out: "final", conf: 70, start: iso(Date.now()), notes: "" });
      a.fgoals[a.seasonStart] = l;
      if (l.length === 1) a.fgMain = l[0].id;
    });
    return;
  }
  if (act === "fg-del") {
    mutate(a => {
      a.fgoals = Object.assign({}, a.fgoals);
      a.fgoals[a.seasonStart] = (a.fgoals[a.seasonStart] || []).filter(g => g.id !== id);
      if (a.fgMain === id) delete a.fgMain;
    });
    return;
  }
  if (act === "tr-del") {
    mutate(a => {
      a.training = (a.training || []).filter(x => x.id !== id);
    });
    return;
  }
  if (act === "fc-link") {
    feedMatches().forEach(({ e, c }) => {
      e.feedComp = c.id;
    });
    saveCal();
    render();
    return;
  }
  if (act === "sg-on") {
    mutate(a => {
      a.picks = a.picks || {};
      a.picks[id] = Object.assign({}, a.picks[id], { on: true });
    });
    return;
  }
  if (act === "sg-skip") {
    mutate(a => {
      a.picks[id] = Object.assign({}, a.picks[id], { on: false });
    });
    return;
  }
  if (act === "sg-tier") {
    const v = b.dataset.v,
      ev = st.cal.events.find(x => x.id === id);
    mutate(a => {
      const k = a.picks[id];
      if (ev && v === ev.tier) delete k.tier;
      else k.tier = v;
      if (v !== "peak") delete k.taper;
    });
    return;
  }
  if (act === "sg-dismiss") {
    mutate(a => {
      a.dismissed = Object.assign({}, a.dismissed, { [id]: 1 });
    });
    return;
  }
  if (act === "sg-restore") {
    mutate(a => {
      a.dismissed = {};
    });
    return;
  }
  if (act === "adj-clear") {
    mutate(a => {
      if (a.adj) delete a.adj[id];
    });
    return;
  }
  if (act === "adj-clear-all") {
    mutate(a => {
      a.adj = {};
    });
    return;
  }
  if (act === "ath-add") {
    st.adding = true;
    render();
  } else if (act === "ath-cancel") {
    st.adding = false;
    render();
  } else if (act === "ath-create" || act === "ath-dup") {
    const n = ($("ath-new").value || "").trim();
    if (!n) {
      $("ath-new").focus();
      return;
    }
    newAthlete(n, act === "ath-dup" ? cur() : null);
  } else if (act === "ath-del") {
    st.confirmDel = "ath";
    render();
  } else if (act === "del-cancel") {
    st.confirmDel = null;
    render();
  } else if (act === "ath-del2") {
    const i = st.cur;
    delete st.athletes[i];
    st.cur = Object.keys(st.athletes)[0] || null;
    st.sel = null;
    st.confirmDel = null;
    persist(i);
    render();
  } else if (act === "blk-prev") {
    st.wk = st.ses = st.wkAsk = null;
    st.sel = Math.max(0, st.sel - 1);
    st.jump = true;
    render();
  } else if (act === "blk-next") {
    st.wk = st.ses = st.wkAsk = null;
    st.sel++;
    st.jump = true;
    render();
  } else if (act === "zoom") {
    st.zoom = +id;
    st.jump = true;
    lsSet("rsp-zoom", id);
    render();
  } else if (act === "ev-edit") {
    st.editing = id;
    st.confirmDel = null;
    render();
    syncEvForm();
    $("ev-name").focus();
  } else if (act === "ev-cancel") {
    st.editing = null;
    render();
    syncEvForm();
  } else if (act === "ev-del") {
    st.confirmDel = id;
    render();
    syncEvForm();
  } else if (act === "ev-del2") {
    st.confirmDel = null;
    if (st.editing === id) st.editing = null;
    st.cal.events = st.cal.events.filter(x => x.id !== id);
    saveCal();
    render();
  } else if (act === "set-reset") {
    mutate(a => {
      a.settings = {};
    });
    syncEvForm();
  }
});
document.addEventListener("submit", e => {
  if (e.target.id === "claim-form") {
    e.preventDefault();
    const code = ($("claim-code").value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 6 || !db || !st.me) return;
    st.claimMsg = "Sending…";
    render();
    db.doc("claims/" + st.me)
      .set({ code })
      .then(
        () => {
          st.claimMsg = `Code ${code} sent. Your plan appears here as soon as your coach's planner has matched it. If nothing happens, check the code with your coach.`;
          render();
        },
        () => {
          st.claimMsg =
            "The code could not be sent. Your coach needs to share the planner with you by email as Editor, with \"anyone with the link\" switched off.";
          render();
        },
      );
    return;
  }
  if (st.role !== "coach") {
    e.preventDefault();
    return;
  }
  if (e.target.id === "tr-form") {
    e.preventDefault();
    const d = $("tr-date").value,
      sc = $("tr-score").value.trim(),
      no = $("tr-note").value.trim();
    if (!d || (!sc && !no)) return;
    mutate(a => {
      a.training = (a.training || []).concat([
        { id: uid(), date: d, ev: $("tr-ev").value, score: sc === "" ? null : +sc, note: no },
      ]);
    });
    return;
  }
  if (e.target.id !== "ev-form") return;
  e.preventDefault();
  const name = $("ev-name").value.trim(),
    start = $("ev-start").value;
  if (!name || !start) return;
  let end = $("ev-end").value || start;
  if (parse(end) < parse(start)) end = start;
  const tsel = $("ev-type").value,
    trn = tsel === "training",
    type = trn ? "comp" : tsel,
    was = st.editing,
    ev = {
      id: was || uid(),
      name,
      type,
      start,
      end,
      disc: type !== "comp" ? "both" : $("ev-disc").value,
      tier: type !== "comp" ? null : $("ev-tier").value,
    };
  if (trn) {
    ev.tier = "small";
    ev.training = true;
  }
  if (type === "comp" && !trn && $("ev-fc") && $("ev-fc").value) ev.feedComp = $("ev-fc").value;
  const i = st.cal.events.findIndex(x => x.id === was);
  if (i >= 0) st.cal.events[i] = ev;
  else {
    st.cal.events.push(ev);
    const all = !!($("ev-all") && $("ev-all").checked);
    Object.keys(st.athletes).forEach(k => {
      if (k === st.cur || all) {
        const a = st.athletes[k];
        a.picks = a.picks || {};
        a.picks[ev.id] = { on: true };
        persist(k);
      }
    });
  }
  st.editing = null;
  saveCal();
  render();
});
/* remember whether the checks panel was left open (toggle does not bubble, so listen while capturing) */
document.addEventListener(
  "toggle",
  e => {
    if (e.target.id !== "checks") return;
    st.checksOpen = e.target.open;
    lsSet("rsp-checks", e.target.open ? "1" : "0");
  },
  true,
);
document.addEventListener("change", e => {
  const t = e.target;
  if (st.role === "locked") return;
  if (st.role === "athlete") {
    const d = t.dataset;
    if (!(d.pick || d.ptier || d.ptaper || d.log || d.logc || d.wn || d.ses || t.id === "wk-copyfrom")) return;
  }
  if (t.id === "bk-file") {
    const file = t.files && t.files[0];
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!d || typeof d.athletes !== "object" || !d.calendar || !Array.isArray(d.calendar.events))
          throw new Error("shape");
        st.restore = { data: d, name: file.name };
        st.bkMsg = "";
      } catch (er) {
        st.restore = null;
        st.bkMsg = `${file.name} is not a planner backup. Choose a file saved with "Download a backup".`;
      }
      render();
    };
    r.onerror = () => {
      st.bkMsg = `${file.name} could not be read.`;
      render();
    };
    r.readAsText(file);
    return;
  }
  if (t.id === "ath-sel") {
    if (st.view === "squad") st.view = "athlete";
    st.cur = t.value;
    st.sel = null;
    st.wk = st.ses = st.wkAsk = null;
    st.editing = null;
    st.confirmDel = null;
    lsSet("rsp-cur", st.cur);
    render();
    syncEvForm();
    return;
  }
  if (t.id === "ev-type" || t.id === "ev-tier" || t.id === "ev-disc") {
    syncEvForm();
    return;
  }
  if (t.id === "ev-start" || t.id === "ev-end") {
    const e0 = $("ev-end"),
      s0 = $("ev-start");
    if (t.id === "ev-start" && t.value && (!e0.value || e0.value < t.value)) e0.value = t.value;
    const fc = $("ev-fc");
    if (fc && !fc.value) fc.value = bestFeedComp(s0.value, e0.value, $("ev-disc").value);
    syncEvForm();
    return;
  }
  if (t.dataset.pick) {
    const id = t.dataset.pick,
      on = t.checked;
    mutate(a => {
      a.picks = a.picks || {};
      a.picks[id] = Object.assign({}, a.picks[id], { on });
    });
    return;
  }
  if (t.dataset.ptier) {
    const id = t.dataset.ptier,
      ev = st.cal.events.find(x => x.id === id),
      v = t.value;
    mutate(a => {
      const k = a.picks[id];
      if (ev && v === ev.tier) delete k.tier;
      else k.tier = v;
      if (v !== "peak") delete k.taper;
    });
    return;
  }
  if (t.dataset.ptaper) {
    const id = t.dataset.ptaper,
      v = parseInt(t.value);
    mutate(a => {
      const k = a.picks[id];
      if (v >= 1) k.taper = clamp(v, 1, 4);
      else delete k.taper;
    });
    return;
  }
  if (t.dataset.fgmain) {
    const id = t.dataset.fgmain;
    mutate(a => {
      a.fgMain = id;
    });
    return;
  }
  if (t.dataset.fg) {
    const [id, f] = t.dataset.fg.split("|"),
      v = t.value;
    mutate(a => {
      a.fgoals = Object.assign({}, a.fgoals);
      a.fgoals[a.seasonStart] = (a.fgoals[a.seasonStart] || []).map(g => {
        if (g.id !== id) return g;
        const n = Object.assign({}, g, { [f]: f === "conf" ? +v : v });
        if (f === "ev") {
          const E = st.feed && st.feed.events[v];
          if (E && !E.bench[n.compId]) n.compId = "";
        }
        return n;
      });
    });
    return;
  }
  if (t.id === "p-season") {
    const v = t.value;
    st.sel = null;
    mutate(a => {
      const l = seasonsOf(a),
        x = l.find(q => q.start === v);
      if (!x) return;
      a.seasons = l;
      a.seasonStart = x.start;
      a.weeks = x.weeks;
    });
    return;
  }
  if (t.id === "wk-copyfrom") {
    st.copyFrom = t.value;
    st.wkAsk = null;
    render();
    return;
  }
  if (t.dataset.ses) {
    const [sid, f] = t.dataset.ses.split("|"),
      k = st.wk;
    mutate(a => {
      const list = ((a.sessions || {})[k] || []).map(x => Object.assign({}, x)),
        x = list.find(y => y.id === sid);
      if (!x) return;
      if (f === "fin") x.fin = t.checked;
      else if (f === "loc" || f === "note") x[f] = t.value.trim();
      else if (f === "type" || f === "ampm") x[f] = t.value;
      else if (f === "day") x.day = clamp(parseInt(t.value) || 0, 0, 6);
      else if (f === "dur") x.dur = clamp(Math.round((parseFloat(t.value) || 0) * 4) / 4, 0, 8);
      else if (t.value === "") delete x[f];
      else x[f] = clamp(Math.round(+t.value) || 0, 0, 1000);
      if (x.type !== "t10") delete x.shots;
      if (x.type !== "t50") ["k", "p", "s"].forEach(q => delete x[q]);
      if (!isRange(x.type)) delete x.fin;
      setSessions(a, k, list);
    });
    return;
  }
  if (t.dataset.log || t.dataset.logc) {
    const [k, f, v] = (t.dataset.log || t.dataset.logc).split("|");
    mutate(a => {
      a.wlog = Object.assign({}, a.wlog);
      const l = (a.wlog[k] = Object.assign({}, a.wlog[k]));
      if (t.dataset.logc) {
        const arr = (l[f] || []).filter(x => x !== v);
        if (t.checked) arr.push(v);
        if (arr.length) l[f] = arr;
        else delete l[f];
      } else if (t.value === "") delete l[f];
      else l[f] = f === "load" ? +t.value : t.value;
      if (f === "health" && l.health !== "niggle" && l.health !== "injured") delete l.affects;
      if (!Object.keys(l).length) delete a.wlog[k];
    });
    return;
  }
  if (t.dataset.wn) {
    const k = t.dataset.wn,
      v = t.value.trim();
    mutate(a => {
      a.weekNotes = Object.assign({}, a.weekNotes);
      if (v) a.weekNotes[k] = v;
      else delete a.weekNotes[k];
    });
    return;
  }
  if (t.dataset.res) {
    const [id, k] = t.dataset.res.split("|"),
      v = t.value.trim();
    mutate(a => {
      a.results = Object.assign({}, a.results);
      const r = (a.results[id] = Object.assign({}, a.results[id]));
      if (v) r[k] = k === "q10" || k === "q50" ? +v : v;
      else delete r[k];
      if (!Object.keys(r).length) delete a.results[id];
    });
    return;
  }
  if (t.dataset.fin) {
    const v = clamp(parseFloat(t.value) || 0, 0, 100);
    mutate(a => {
      a.settings = a.settings || {};
      a.settings.finals = Object.assign({}, a.settings.finals, { [t.dataset.fin]: v });
    });
    return;
  }
  if (t.dataset.p) {
    const k = t.dataset.p;
    let v = t.value;
    if (k === "issfId") {
      v = v.trim().toUpperCase().replace(/\s+/g, "");
      mutate(a => {
        if (!v) {
          delete a.issfId;
          return;
        }
        a.issfId = v;
        if (genderOf(v) && !a.birthYear) a.birthYear = +v.slice(10, 14);
      });
      return;
    }
    if (k === "birthYear") {
      v = parseInt(v);
      mutate(a => {
        if (v >= 1940 && v <= 2020) a.birthYear = v;
        else delete a.birthYear;
      });
      return;
    }
    if (k === "seasonStart" && v) {
      mutate(a => {
        const old = a.seasonStart;
        a.seasons = seasonsOf(a).filter(q => q.start !== old && q.start !== v);
        if (a.fgoals && a.fgoals[old] && !a.fgoals[v]) {
          a.fgoals = Object.assign({}, a.fgoals, { [v]: a.fgoals[old] });
          delete a.fgoals[old];
        }
        a.seasonStart = v;
      });
      st.sel = null;
      render();
      return;
    }
    if (k === "name") {
      v = v.trim();
      if (!v) {
        render();
        return;
      }
    }
    if (k === "seasonStart" && !v) {
      render();
      return;
    }
    if (k === "weeks") v = clamp(parseInt(v) || 52, 8, 104);
    if (k === "hoursMax") v = clamp(parseFloat(v) || 30, 5, 50);
    if (k === "seasonStart" || k === "weeks") st.sel = null;
    mutate(a => {
      a[k] = v;
    });
    syncEvForm();
    return;
  }
  if (t.dataset.s) {
    const v = clamp(parseInt(t.value) || 0, +t.min, +t.max);
    mutate(a => {
      a.settings = a.settings || {};
      a.settings[t.dataset.s] = v;
    });
    st.sel = Math.min(st.sel, 1e9);
    syncEvForm();
    return;
  }
  if (t.dataset.sh) {
    const v = clamp(parseFloat(t.value) || 0, +t.min, +t.max);
    mutate(a => {
      a.settings = a.settings || {};
      a.settings.shots = Object.assign({}, a.settings.shots, { [t.dataset.sh]: v });
    });
    return;
  }
  if (t.dataset.adj) {
    const [k, f] = t.dataset.adj.split("|"),
      v = t.value;
    mutate(a => {
      a.adj = a.adj || {};
      const j = (a.adj[k] = a.adj[k] || {});
      if (v === "" || v === "auto") delete j[f];
      else j[f] = f === "phase" ? v : +v;
      if (!Object.keys(j).length) delete a.adj[k];
    });
    const w = plan(view(cur())).W.find(x => iso(x.start) === k);
    if (w && w.block !== st.sel) {
      st.sel = w.block;
      render();
    }
    return;
  }
  if (t.dataset.sp) {
    const [p, k] = t.dataset.sp.split("."),
      v = clamp(parseFloat(t.value) || 0, 0, 100);
    mutate(a => {
      a.settings = a.settings || {};
      const sp = (a.settings.split = a.settings.split || {});
      sp[p] = Object.assign({}, DEF.split[p], sp[p] || {});
      sp[p][k] = v;
    });
    syncEvForm();
  }
});
let rz;
window.addEventListener("resize", () => {
  clearTimeout(rz);
  rz = setTimeout(() => {
    if (st.mode !== "loading" && cur() && !document.activeElement.matches("input,select")) {
      render();
      syncEvForm();
    }
  }, 200);
});
boot().then(syncEvForm);
