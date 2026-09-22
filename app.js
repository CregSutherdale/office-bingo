/* Sales Bingo -- one shared weekly card for the office.
 * Live mode: Supabase (config.js) through the bingo_* functions in supabase/setup.sql, which
 * check the team code. Demo mode (no config): saved on this device only, synced across tabs. */
(function () {
  "use strict";

  const CFG = window.BINGO_CONFIG || {};
  const FREE = "FREE";
  const CENTER = 12;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ small helpers
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: fine */ } },
  };
  function ymd(d) {
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function mondayOf(d) {
    const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
    return m;
  }
  function parseYmd(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function weekText(id) {
    const d = parseYmd(id);
    return "Week of " + d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "";
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0][1] || ""))).toUpperCase();
  }
  function randInt(n) {
    const a = new Uint32Array(1);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return a[0] % n;
  }
  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) { const j = randInt(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  }
  function el(tag, props, kids) {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === "text") n.textContent = props[k];
      else if (k === "on") for (const ev in props.on) n.addEventListener(ev, props.on[ev]);
      else if (k === "class") n.className = props[k];
      else n.setAttribute(k, props[k]);
    }
    (kids || []).forEach((c) => c && n.appendChild(c));
    return n;
  }

  // ------------------------------------------------------------------ defaults (match setup.sql)
  const DEFAULT_SETTINGS = {
    title: "Sales Bingo",
    team: [],
    items: [
      { label: "Raw New Auto", count: 2 }, { label: "2 Raw New Auto", count: 2 }, { label: "Added Auto", count: 3 },
      { label: "Home", count: 3 }, { label: "Raw New Home", count: 1 }, { label: "Renters", count: 2 },
      { label: "Life", count: 2 }, { label: "PAP", count: 1 }, { label: "RDP", count: 1 }, { label: "Boat", count: 1 },
      { label: "Saved Policy", count: 2 }, { label: "Google Review", count: 2 }, { label: "Successful Pivot", count: 2 },
    ],
  };
  const SEED_WEEK = "2026-09-21";
  const SEED_LAYOUT = [
    "Google Review", "Home", "Renters", "Boat", "Successful Pivot",
    "Life", "Raw New Auto", "Google Review", "Home", "2 Raw New Auto",
    "Successful Pivot", "Added Auto", FREE, "2 Raw New Auto", "Raw New Home",
    "Saved Policy", "Renters", "Added Auto", "Google Review", "PAP",
    "Home", "Saved Policy", "Life", "Added Auto", "Raw New Auto",
  ];
  const SEED_MARKS = [11, 17, 20, 23];

  /** 24 labels from the item counts, shuffled, FREE in the middle. More than 24: a random
   * 24 of them. Fewer: random repeats fill the gap. */
  function shuffledLayout(items) {
    let pool = [];
    (items || []).forEach((it) => { for (let i = 0; i < Math.max(0, it.count | 0); i++) pool.push(it.label); });
    if (!pool.length) pool = ["Square"];
    shuffleInPlace(pool);
    if (pool.length > 24) pool = pool.slice(0, 24);
    const base = pool.slice();
    while (pool.length < 24) pool.push(base[randInt(base.length)]);
    shuffleInPlace(pool);
    pool.splice(CENTER, 0, FREE);
    return pool;
  }

  // ------------------------------------------------------------------ back ends
  function LiveBackend(code) {
    const sb = window.supabase.createClient(CFG.url, CFG.anonKey, { auth: { persistSession: false } });
    let channel = null;
    async function rpc(name, args) {
      const { data, error } = await sb.rpc(name, Object.assign({ p_code: code }, args));
      if (error) {
        const e = new Error(error.message || "request failed");
        e.badCode = /bad team code/i.test(error.message || "");
        throw e;
      }
      return data;
    }
    return {
      mode: "live",
      state: (week) => rpc("bingo_state", { p_week: week }),
      ensureWeek: (week, layout) => rpc("bingo_ensure_week", { p_week: week, p_layout: layout }),
      setLayout: (week, layout) => rpc("bingo_set_layout", { p_week: week, p_layout: layout }),
      mark: (week, cell, by) => rpc("bingo_mark", { p_week: week, p_cell: cell, p_by: by }),
      unmark: (week, cell) => rpc("bingo_unmark", { p_week: week, p_cell: cell }),
      saveSettings: (week, s) => rpc("bingo_save_settings", { p_week: week, p_settings: s }),
      listen(onPing) {
        try {
          let h = 0; for (const c of code) h = (h * 31 + c.charCodeAt(0)) >>> 0;
          channel = sb.channel("office-bingo-" + h.toString(36), { config: { broadcast: { self: false } } })
            .on("broadcast", { event: "changed" }, () => onPing())
            .subscribe();
        } catch (e) { /* polling still keeps everyone current */ }
      },
      ping(week) { try { channel && channel.send({ type: "broadcast", event: "changed", payload: { week } }); } catch (e) {} },
    };
  }

  function DemoBackend() {
    const KEY = "bingo-demo-v1";
    const bc = ("BroadcastChannel" in window) ? new BroadcastChannel("bingo-demo") : null;
    function load() {
      let db = null;
      try { db = JSON.parse(store.get(KEY) || "null"); } catch (e) { db = null; }
      if (!db) {
        db = { settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), weeks: {} };
        const marks = {}; SEED_MARKS.forEach((c) => { marks[c] = { by: "", at: new Date().toISOString() }; });
        db.weeks[SEED_WEEK] = { layout: SEED_LAYOUT.slice(), marks };
        store.set(KEY, JSON.stringify(db));
      }
      return db;
    }
    function save(db) { store.set(KEY, JSON.stringify(db)); }
    function view(db, week) {
      const w = db.weeks[week];
      return {
        settings: db.settings,
        week: w ? { id: week, layout: w.layout } : null,
        marks: w ? Object.keys(w.marks).map((c) => ({ cell: +c, by: w.marks[c].by, at: w.marks[c].at })).sort((a, b) => a.cell - b.cell) : [],
        weeks: Object.keys(db.weeks).sort().reverse().slice(0, 26),
      };
    }
    const ok = (fn) => async (...a) => { const db = load(); const r = fn(db, ...a); save(db); return view(db, r); };
    return {
      mode: "demo",
      state: async (week) => view(load(), week),
      ensureWeek: ok((db, week, layout) => { if (!db.weeks[week]) db.weeks[week] = { layout, marks: {} }; return week; }),
      setLayout: ok((db, week, layout) => { db.weeks[week] = { layout, marks: {} }; return week; }),
      mark: ok((db, week, cell, by) => { const w = db.weeks[week]; if (w && !w.marks[cell] && cell !== CENTER) w.marks[cell] = { by, at: new Date().toISOString() }; return week; }),
      unmark: ok((db, week, cell) => { const w = db.weeks[week]; if (w) delete w.marks[cell]; return week; }),
      saveSettings: ok((db, week, s) => { db.settings = s; return week; }),
      listen(onPing) { if (bc) bc.onmessage = () => onPing(); window.addEventListener("storage", (e) => { if (e.key === KEY) onPing(); }); },
      ping() { if (bc) bc.postMessage("changed"); },
    };
  }

  // ------------------------------------------------------------------ state
  const S = {
    backend: null,
    thisWeek: ymd(mondayOf(new Date())),
    viewWeek: null,
    settings: DEFAULT_SETTINGS,
    layout: null,
    marks: new Map(),
    weeks: [],
    me: store.get("bingo-me") || "",
    lastBingos: null,
    fresh: new Set(),
    busy: false,
  };
  S.viewWeek = S.thisWeek;
  const readonly = () => S.viewWeek !== S.thisWeek;

  function apply(st) {
    if (!st) return;
    if (st.settings) S.settings = st.settings;
    S.layout = st.week ? st.week.layout : null;
    S.marks = new Map((st.marks || []).map((m) => [m.cell, m]));
    S.weeks = st.weeks || [];
    render();
  }

  async function refresh() {
    if (!S.backend) return;
    try {
      let st = await S.backend.state(S.viewWeek);
      if (!st.week && S.viewWeek === S.thisWeek) {
        st = await S.backend.ensureWeek(S.thisWeek, shuffledLayout((st.settings || S.settings).items));
      }
      setStatus(S.backend.mode === "live" ? "live" : "demo");
      apply(st);
    } catch (e) { handleError(e); }
  }

  function handleError(e) {
    if (e && e.badCode) { store.set("bingo-code", ""); askCode("That team code didn't work. Check it with whoever set this up."); return; }
    setStatus("off");
    toast("Couldn't reach the board. Check your connection; it will retry.");
  }

  // ------------------------------------------------------------------ rendering
  const grid = $("grid");
  const cells = [];
  for (let i = 0; i < 25; i++) {
    const b = el("button", { class: "cell", type: "button", "data-i": String(i) });
    b.addEventListener("click", () => onCell(i));
    cells.push(b);
    grid.appendChild(b);
  }
  const SVGNS = "http://www.w3.org/2000/svg";
  const lineLayer = document.createElementNS(SVGNS, "svg");
  lineLayer.setAttribute("class", "lines");
  lineLayer.setAttribute("viewBox", "0 0 100 100");
  lineLayer.setAttribute("preserveAspectRatio", "none");
  lineLayer.setAttribute("aria-hidden", "true");
  grid.appendChild(lineLayer);

  function xSvg(i) {
    // a hand-drawn X: each square gets its own slight wobble, same every time
    const r = (k) => (((i * 9301 + k * 49297) % 233280) / 233280 - 0.5) * 10;
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("class", "x"); s.setAttribute("viewBox", "0 0 100 100"); s.setAttribute("aria-hidden", "true");
    const p1 = document.createElementNS(SVGNS, "path");
    p1.setAttribute("d", `M${10 + r(1)} ${12 + r(2)} Q ${50 + r(3)} ${46 + r(4)} ${90 + r(5)} ${88 + r(6)}`);
    const p2 = document.createElementNS(SVGNS, "path");
    p2.setAttribute("d", `M${88 + r(7)} ${10 + r(8)} Q ${52 + r(9)} ${52 + r(10)} ${12 + r(11)} ${90 + r(12)}`);
    s.appendChild(p1); s.appendChild(p2);
    return s;
  }

  const LINES = (() => {
    const L = [];
    for (let r = 0; r < 5; r++) L.push([0, 1, 2, 3, 4].map((c) => r * 5 + c));
    for (let c = 0; c < 5; c++) L.push([0, 1, 2, 3, 4].map((r) => r * 5 + c));
    L.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);
    return L;
  })();
  const isMarked = (i) => i === CENTER || S.marks.has(i);

  function render() {
    document.title = S.settings.title || "Sales Bingo";
    $("title").textContent = S.settings.title || "Sales Bingo";
    $("meBtn").textContent = S.me ? S.me : "Who?";
    $("weekLabel").textContent = weekText(S.viewWeek);
    $("pastBanner").hidden = !readonly();
    $("pastText").textContent = weekText(S.viewWeek) + " (past week, view only)";
    $("shuffleBtn").disabled = readonly();
    grid.classList.toggle("readonly", readonly());
    const layout = S.layout || new Array(25).fill("");
    cells.forEach((b, i) => {
      const label = i === CENTER ? FREE : (layout[i] || "");
      b.textContent = "";
      b.classList.toggle("free", i === CENTER);
      const lab = el("span", { class: "label", text: i === CENTER ? "Free Space" : label });
      lab.style.setProperty("--tilt", ((((i * 7) % 5) - 2) * 0.8).toFixed(1) + "deg");
      b.appendChild(lab);
      const m = S.marks.get(i);
      if (isMarked(i)) {
        b.appendChild(xSvg(i));
        if (m && m.by) b.appendChild(el("span", { class: "who", text: initials(m.by) }));
      }
      b.classList.toggle("fresh", S.fresh.has(i));
      const row = Math.floor(i / 5) + 1, col = (i % 5) + 1;
      b.setAttribute("aria-label", `Row ${row}, column ${col}: ${i === CENTER ? "Free space" : label}` +
        (isMarked(i) ? (m && m.by ? `, X by ${m.by}` : ", X") : ""));
    });
    S.fresh.clear();

    // bingo lines
    while (lineLayer.firstChild) lineLayer.removeChild(lineLayer.firstChild);
    const done = LINES.filter((l) => l.every(isMarked));
    done.forEach((l) => {
      const a = l[0], z = l[4];
      const cx = (k) => (k % 5) * 20 + 10, cy = (k) => Math.floor(k / 5) * 20 + 10;
      const ln = document.createElementNS(SVGNS, "line");
      const dx = Math.sign(cx(z) - cx(a)) * 7, dy = Math.sign(cy(z) - cy(a)) * 7;
      ln.setAttribute("x1", cx(a) - dx); ln.setAttribute("y1", cy(a) - dy);
      ln.setAttribute("x2", cx(z) + dx); ln.setAttribute("y2", cy(z) + dy);
      ln.setAttribute("vector-effect", "non-scaling-stroke");
      lineLayer.appendChild(ln);
    });
    const total = [...Array(25).keys()].filter(isMarked).length;
    const score = $("score"); score.textContent = "";
    score.appendChild(el("span", { class: "pill" + (done.length ? " bingo" : "") }, [
      el("span", { text: done.length === 1 ? "Bingo" : "Bingos" }), el("span", { class: "n", text: String(done.length) })]));
    score.appendChild(el("span", { class: "pill" }, [el("span", { text: "Squares" }), el("span", { class: "n", text: total + "/25" })]));
    if (!readonly()) {
      if (S.lastBingos !== null && done.length > S.lastBingos) celebrate(total === 25 ? "BLACKOUT!" : "BINGO!");
      S.lastBingos = done.length;
    }

    // who got what
    const counts = new Map();
    S.marks.forEach((m) => { const k = m.by || "Whiteboard"; counts.set(k, (counts.get(k) || 0) + 1); });
    const leader = $("leader"); leader.textContent = "";
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!rows.length) leader.appendChild(el("span", { class: "small", text: "No X's yet this week." }));
    rows.forEach(([name, n]) => leader.appendChild(el("span", { class: "pill" }, [el("span", { text: name }), el("span", { class: "n", text: String(n) })])));
  }

  function setStatus(kind) {
    const dot = $("dot"); dot.className = "dot " + (kind === "live" ? "live" : kind === "demo" ? "demo" : "off");
    $("statusText").textContent = kind === "live" ? "Live for everyone" : kind === "demo" ? "Demo (this phone only)" : "Offline, retrying";
    $("demoBanner").hidden = kind !== "demo";
  }

  let toastTimer = null;
  function toast(msg, cls) {
    const t = $("toast"); t.textContent = msg; t.className = "toast" + (cls ? " " + cls : ""); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, cls ? 2600 : 3200);
  }

  function celebrate(word) {
    toast(word, "bingo");
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const c = el("canvas", { class: "confetti" }); document.body.appendChild(c);
    const ctx = c.getContext("2d"); const W = (c.width = innerWidth), H = (c.height = innerHeight);
    const colors = ["#EE7A1E", "#1E3E9E", "#F3B53A", "#141414", "#1F7A4E"];
    const bits = Array.from({ length: 90 }, () => ({ x: W / 2, y: H * 0.35, vx: (Math.random() - 0.5) * 9, vy: -Math.random() * 9 - 3,
      r: Math.random() * 6 + 3, c: colors[randInt(colors.length)], a: Math.random() * 6 }));
    const t0 = performance.now();
    (function step(t) {
      ctx.clearRect(0, 0, W, H);
      bits.forEach((b) => { b.vy += 0.28; b.x += b.vx; b.y += b.vy; b.a += 0.2;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.a); ctx.fillStyle = b.c; ctx.fillRect(-b.r, -b.r / 2, b.r * 2, b.r); ctx.restore(); });
      if (t - t0 < 1800) requestAnimationFrame(step); else c.remove();
    })(t0);
  }

  // ------------------------------------------------------------------ actions
  async function onCell(i) {
    if (readonly() || !S.layout || i === CENTER || S.busy) return;
    if (!S.me) { askName(() => onCell(i)); return; }
    const m = S.marks.get(i);
    if (m) { showMark(i, m); return; }
    // optimistic: draw the X now, then save
    S.marks.set(i, { cell: i, by: S.me, at: new Date().toISOString() });
    S.fresh.add(i);
    render();
    try {
      apply(await S.backend.mark(S.viewWeek, i, S.me));
      S.backend.ping(S.viewWeek);
    } catch (e) { S.marks.delete(i); render(); handleError(e); }
  }

  function showMark(i, m) {
    const when = m.at ? new Date(m.at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
    openSheet([
      el("h3", { text: S.layout[i] }),
      el("p", { text: m.by ? `X'd by ${m.by}${when ? " · " + when : ""}` : "X'd on the whiteboard before the app." }),
      el("div", { class: "actions" }, [
        el("button", { class: "btn", type: "button", text: "Keep it", on: { click: closeSheet } }),
        el("button", { class: "btn danger", type: "button", text: "Remove X", on: { click: async () => {
          closeSheet();
          const prev = S.marks.get(i); S.marks.delete(i); render();
          try { apply(await S.backend.unmark(S.viewWeek, i)); S.backend.ping(S.viewWeek); }
          catch (e) { S.marks.set(i, prev); render(); handleError(e); }
        } } }),
      ]),
    ]);
  }

  function onShuffle() {
    if (readonly()) return;
    const n = S.marks.size;
    openSheet([
      el("h3", { text: "Shuffle this week's card?" }),
      el("p", { text: "Every square moves to a new random spot using the items in Settings." + (n ? ` This clears all ${n} X's for this week.` : "") }),
      el("div", { class: "actions" }, [
        el("button", { class: "btn", type: "button", text: "Cancel", on: { click: closeSheet } }),
        el("button", { class: "btn primary", type: "button", text: "Shuffle", on: { click: async () => {
          closeSheet();
          try { S.lastBingos = null; apply(await S.backend.setLayout(S.thisWeek, shuffledLayout(S.settings.items))); S.backend.ping(S.thisWeek); toast("New card shuffled"); }
          catch (e) { handleError(e); }
        } } }),
      ]),
    ]);
  }

  function onHistory() {
    const list = el("div", { class: "weeks" });
    const weeks = S.weeks.length ? S.weeks : [S.thisWeek];
    weeks.forEach((w) => list.appendChild(el("button", { type: "button", on: { click: () => { closeSheet(); goWeek(w); } } }, [
      el("span", { text: weekText(w) }), el("span", { class: "small", text: w === S.thisWeek ? "this week" : "view" })])));
    openSheet([el("h3", { text: "Past weeks" }), list,
      el("div", { class: "actions" }, [el("button", { class: "btn", type: "button", text: "Close", on: { click: closeSheet } })])]);
  }

  function goWeek(w) { S.viewWeek = w; S.lastBingos = null; refresh(); }

  function onSettings() {
    const s = JSON.parse(JSON.stringify(S.settings));
    s.items = s.items || []; s.team = s.team || [];
    const titleIn = el("input", { id: "setTitle", value: s.title || "", maxlength: "40", "aria-label": "Card title" });
    const items = el("div", { class: "items" });
    const total = el("div", { class: "total" });
    const team = el("div", { class: "team" });

    function drawItems() {
      items.textContent = "";
      s.items.forEach((it, idx) => {
        items.appendChild(el("div", { class: "item" }, [
          el("span", { class: "nm", text: it.label }),
          el("button", { class: "step", type: "button", text: "−", "aria-label": "One fewer " + it.label,
            on: { click: () => { it.count = Math.max(0, it.count - 1); drawItems(); } } }),
          el("span", { class: "ct", text: String(it.count) }),
          el("button", { class: "step", type: "button", text: "+", "aria-label": "One more " + it.label,
            on: { click: () => { it.count = Math.min(24, it.count + 1); drawItems(); } } }),
          el("button", { class: "rm", type: "button", text: "Remove", on: { click: () => { s.items.splice(idx, 1); drawItems(); } } }),
        ]));
      });
      const n = s.items.reduce((a, it) => a + (it.count | 0), 0);
      total.textContent = n === 24 ? "24 of 24 squares" :
        n > 24 ? `${n} squares listed for 24 spots: each shuffle leaves ${n - 24} out at random` :
        `${n} squares listed for 24 spots: each shuffle repeats ${24 - n} at random`;
      total.className = "total" + (n === 24 ? "" : " bad");
    }
    function drawTeam() {
      team.textContent = "";
      s.team.forEach((nm, idx) => team.appendChild(el("span", {}, [el("span", { text: nm }),
        el("button", { class: "rm", type: "button", text: "×", "aria-label": "Remove " + nm, on: { click: () => { s.team.splice(idx, 1); drawTeam(); } } })])));
      if (!s.team.length) team.appendChild(el("span", { class: "small", text: "Names get added when each person first opens the app." }));
    }
    const newItem = el("input", { id: "newItem", placeholder: "New square, e.g. Umbrella", maxlength: "28", "aria-label": "New square name" });
    const addItem = el("button", { class: "btn", type: "button", text: "Add", on: { click: () => {
      const v = newItem.value.trim(); if (!v) return;
      const hit = s.items.find((it) => it.label.toLowerCase() === v.toLowerCase());
      if (hit) hit.count++; else s.items.push({ label: v, count: 1 });
      newItem.value = ""; drawItems(); } } });
    drawItems(); drawTeam();

    const invite = location.origin + location.pathname + "#team=" + encodeURIComponent(store.get("bingo-code") || "");
    const kids = [
      el("h3", { text: "Settings" }),
      el("label", { class: "lab", for: "setTitle", text: "Card title" }), titleIn,
      el("label", { class: "lab", text: "Squares on the card" }),
      el("p", { text: "Changes apply to the next shuffle. This week's card stays as it is." }),
      items, total, el("div", { class: "field" }, [newItem, addItem]),
      el("label", { class: "lab", text: "Team" }), team,
    ];
    if (S.backend.mode === "live") {
      kids.push(el("label", { class: "lab", text: "Invite link" }),
        el("p", { text: "Send this to the team. Opening it once sets up their phone." }),
        el("div", { class: "field" }, [el("input", { id: "inviteLink", value: invite, readonly: "readonly", "aria-label": "Invite link" }),
          el("button", { class: "btn", type: "button", text: "Copy", on: { click: async () => {
            try { await navigator.clipboard.writeText(invite); toast("Invite link copied"); } catch (e) { $("inviteLink").select(); } } } })]));
    }
    kids.push(el("div", { class: "actions" }, [
      el("button", { class: "btn", type: "button", text: "Cancel", on: { click: closeSheet } }),
      el("button", { class: "btn primary", type: "button", text: "Save", on: { click: async () => {
        s.title = titleIn.value.trim() || "Sales Bingo";
        s.items = s.items.filter((it) => it.label && it.count > 0);
        closeSheet();
        try { apply(await S.backend.saveSettings(S.viewWeek, s)); S.backend.ping(S.viewWeek); toast("Settings saved"); }
        catch (e) { handleError(e); }
      } } }),
    ]));
    openSheet(kids);
  }

  function askName(then) {
    const input = el("input", { id: "newName", placeholder: "Your first name", maxlength: "24", "aria-label": "Your name" });
    const pick = async (name) => {
      name = String(name || "").trim(); if (!name) return;
      S.me = name; store.set("bingo-me", name); closeSheet(); render();
      const team = (S.settings.team || []).slice();
      if (!team.some((t) => t.toLowerCase() === name.toLowerCase())) {
        team.push(name);
        try { apply(await S.backend.saveSettings(S.viewWeek, Object.assign({}, S.settings, { team }))); S.backend.ping(S.viewWeek); }
        catch (e) { handleError(e); }
      }
      if (then) then();
    };
    const names = el("div", { class: "names" });
    (S.settings.team || []).forEach((n) => names.appendChild(el("button", { type: "button", text: n, on: { click: () => pick(n) } })));
    openSheet([
      el("h3", { text: "Who's using this phone?" }),
      el("p", { text: "Your X's get your initials so everyone sees who got what." }),
      names,
      el("div", { class: "field" }, [input, el("button", { class: "btn primary", type: "button", text: "That's me", on: { click: () => pick(input.value) } })]),
    ], !!S.me);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(input.value); });
  }

  function askCode(msg) {
    const input = el("input", { id: "teamCode", placeholder: "Team code", autocomplete: "off", autocapitalize: "none", "aria-label": "Team code" });
    const go = () => {
      const v = input.value.trim(); if (!v) return;
      store.set("bingo-code", v); closeSheet(); start();
    };
    openSheet([
      el("h3", { text: "Enter the team code" }),
      el("p", { text: msg || "Ask whoever set up the board, or open the invite link they sent." }),
      el("div", { class: "field" }, [input, el("button", { class: "btn primary", type: "button", text: "Join", on: { click: go } })]),
    ], false);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  }

  // ------------------------------------------------------------------ sheet
  const dlg = $("dlg");
  let dismissable = true;
  function openSheet(kids, canDismiss) {
    dismissable = canDismiss !== false;
    const sh = $("sheet"); sh.textContent = ""; kids.forEach((k) => sh.appendChild(k));
    if (!dlg.open) { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", ""); }
  }
  function closeSheet() { if (dlg.open) { if (dlg.close) dlg.close(); else dlg.removeAttribute("open"); } }
  dlg.addEventListener("cancel", (e) => { if (!dismissable) e.preventDefault(); });
  dlg.addEventListener("click", (e) => { if (e.target === dlg && dismissable) closeSheet(); });

  // ------------------------------------------------------------------ boot
  $("meBtn").addEventListener("click", () => askName(null));
  $("shuffleBtn").addEventListener("click", onShuffle);
  $("historyBtn").addEventListener("click", onHistory);
  $("settingsBtn").addEventListener("click", onSettings);
  $("backBtn").addEventListener("click", () => goWeek(S.thisWeek));

  let pollTimer = null;
  function start() {
    const live = !!(CFG.url && CFG.anonKey && window.supabase);
    if (live) {
      const code = store.get("bingo-code");
      if (!code) { askCode(); return; }
      S.backend = LiveBackend(code);
    } else {
      S.backend = DemoBackend();
    }
    S.backend.listen(() => refresh());
    refresh().then(() => { if (!S.me) askName(null); });
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 15000);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      const w = ymd(mondayOf(new Date()));
      if (w !== S.thisWeek) { const wasCurrent = S.viewWeek === S.thisWeek; S.thisWeek = w; if (wasCurrent) S.viewWeek = w; }
      refresh();
    }
  });

  // invite link: #team=CODE -> remember it on this device
  const m = /[#&]team=([^&]+)/.exec(location.hash);
  if (m) store.set("bingo-code", decodeURIComponent(m[1]));
  render();
  start();
})();
