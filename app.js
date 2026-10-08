// rsvp_wed_tab (POC) — per-head seats, 6 per table, LOCAL ONLY.
// Guest list loads READ-ONLY from the Sheet (or seed offline).
// Seating plan + check-ins live in localStorage only — never pushed to Sheet.
(function () {
"use strict";

var LS_TABLES = "rsvp-tab-tables-v1";
var LS_GUESTS = "rsvp-tab-guests-v1";   // last Sheet snapshot (cache)
var LS_SEAT = "rsvp-tab-seating-v1";    // POC seating overlay {CODE: tableName}
var LS_CHECKIN = "rsvp-tab-checkin-v1"; // POC check-ins {CODE: [bool per head]}
var SS_AUTH = "rsvp-tab-admin";

var tables = [];
var guests = [];
var selectedTableId = null;
var loading = false;
var syncError = "";

function pocLocal() { return window.POC_LOCAL_ONLY !== false; }
function defSeats() { return window.DEFAULT_SEATS || 6; }

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function normCode(s) { return window.normCode ? window.normCode(s) : String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function normName(s) { return window.normName ? window.normName(s) : String(s || "").toLowerCase().trim().replace(/\s+/g, " "); }
function useGas() { return !!(window.usingGas && window.usingGas()); }
function uid() { return "t" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }

function normalizeGuest(g) {
  var comps = Array.isArray(g.companions)
    ? g.companions
    : String(g.companions || "").split(/[;,\n]+/).map(function (c) { return c.trim(); }).filter(Boolean);
  var st = String(g.status || "pending").toLowerCase();
  return {
    code: String(g.code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""),
    name: String(g.name || "").trim(),
    pax: Math.max(1, parseInt(g.pax, 10) || 1),
    side: String(g.side || "Both").trim() || "Both",
    table: String(g.table || "").trim(),
    status: (st === "attending" || st === "confirmed") ? "attending" : st === "declined" ? "declined" : "pending",
    companions: comps.map(function (c) { return String(c).trim(); }).filter(Boolean),
    contact: String(g.contact || "").trim(),
    message: String(g.message || "").trim()
  };
}

// ---------- per-head model: 1 seat per head ----------
// attending -> [name, ...companions]; pending -> [name, +1 x (pax-1)]; declined -> []
function plannedHeads(g) {
  if (!g || g.status === "declined") return [];
  if (g.status === "attending") {
    var heads = [g.name];
    (g.companions || []).forEach(function (c) { heads.push(c); });
    return heads;
  }
  var out = [g.name];
  for (var i = 1; i < g.pax; i++) out.push("+1");
  return out;
}
function loadMap(key) {
  try {
    var v = JSON.parse(localStorage.getItem(key) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch (e) { return {}; }
}
function saveMap(key, obj) {
  try { localStorage.setItem(key, JSON.stringify(obj || {})); } catch (e) {}
}
function checkinArr(code, len) {
  var map = loadMap(LS_CHECKIN);
  var arr = map[normCode(code)] || [];
  while (arr.length < len) arr.push(false);
  return arr.slice(0, len);
}
function isChecked(code, idx) {
  var map = loadMap(LS_CHECKIN);
  var arr = map[normCode(code)] || [];
  return !!arr[idx];
}
function toggleCheckin(code, idx) {
  var g = guests.find(function (x) { return normCode(x.code) === normCode(code); });
  if (!g) return;
  var len = plannedHeads(g).length;
  var map = loadMap(LS_CHECKIN);
  var key = normCode(code);
  var arr = map[key] || [];
  while (arr.length < len) arr.push(false);
  arr[idx] = !arr[idx];
  map[key] = arr.slice(0, len);
  saveMap(LS_CHECKIN, map);
  render();
}
function resetCheckins() {
  if (!confirm("Clear all check-ins on this device?")) return;
  try { localStorage.removeItem(LS_CHECKIN); } catch (e) {}
  render();
  setSyncMsg("Check-ins cleared (this device only).", true);
}

// ---------- tables ----------
function loadTables() {
  try {
    var raw = localStorage.getItem(LS_TABLES);
    if (raw) {
      var arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        tables = arr.map(sanitizeTable).filter(Boolean);
        return;
      }
    }
  } catch (e) {}
  tables = (window.SEED_TABLES || []).map(function (t) { return Object.assign({}, t); });
  saveTables();
}
function sanitizeTable(t) {
  if (!t) return null;
  var name = String(t.name || "").trim();
  if (!name) return null;
  var shape = t.shape === "rect" || t.shape === "long" ? t.shape : "round";
  return {
    id: String(t.id || uid()),
    name: name,
    shape: shape,
    seats: Math.max(1, Math.min(40, parseInt(t.seats, 10) || defSeats())),
    x: Math.max(0, Math.min(1400, parseInt(t.x, 10) || 0)),
    y: Math.max(0, Math.min(1400, parseInt(t.y, 10) || 0)),
    notes: String(t.notes || "")
  };
}
function saveTables() {
  try { localStorage.setItem(LS_TABLES, JSON.stringify(tables)); } catch (e) {}
}
function tableById(id) { return tables.find(function (t) { return t.id === id; }); }
function tableByName(nm) {
  var n = normName(nm);
  return tables.find(function (t) { return normName(t.name) === n; });
}
function ensureTableFor(name) {
  if (!name || tableByName(name)) return;
  tables.push({ id: uid(), name: name, shape: "round", seats: defSeats(), x: 40 + (tables.length % 4) * 220, y: 480, notes: "auto" });
  saveTables();
}

// ---------- guests (Sheet = read-only source, POC overlay on top) ----------
function loadLocalGuests() {
  try {
    var raw = localStorage.getItem(LS_GUESTS);
    if (raw) return JSON.parse(raw).map(normalizeGuest);
  } catch (e) {}
  return (window.SEED_GUESTS || []).map(normalizeGuest);
}
function applySeatingOverlay(list) {
  var seatMap = loadMap(LS_SEAT);
  list.forEach(function (g) {
    var key = normCode(g.code);
    if (seatMap[key] !== undefined) g.table = seatMap[key];
  });
  return list;
}
function isAttending(g) { return g.status === "attending"; }
function isDeclined(g) { return g.status === "declined"; }

async function refresh() {
  loading = true; syncError = ""; render();
  try {
    if (useGas()) {
      var res = await window.gasGet({ action: "list" });
      if (!res || !res.ok) throw new Error((res && res.error) || "list failed");
      guests = applySeatingOverlay((res.guests || []).map(normalizeGuest));
      try { localStorage.setItem(LS_GUESTS, JSON.stringify(guests)); } catch (e) {}
      guests.forEach(function (g) { if (g.table) ensureTableFor(g.table); });
    } else {
      guests = applySeatingOverlay(loadLocalGuests());
    }
  } catch (err) {
    syncError = String((err && err.message) || err);
    guests = applySeatingOverlay(loadLocalGuests());
  } finally {
    loading = false;
    render();
  }
}

// heads seated at a table: [{code, label, side, status, headIdx, checked}]
function headsAt(tableName) {
  var n = normName(tableName);
  var out = [];
  guests.forEach(function (g) {
    if (isDeclined(g)) return;
    if (normName(g.table || "") !== n) return;
    plannedHeads(g).forEach(function (label, i) {
      out.push({ code: g.code, guest: g.name, label: label, side: g.side, status: g.status, headIdx: i, checked: isChecked(g.code, i) });
    });
  });
  return out;
}
function plannedCountAt(tableName) {
  var n = normName(tableName);
  return guests.reduce(function (a, g) {
    if (isDeclined(g)) return a;
    if (normName(g.table || "") !== n) return a;
    return a + plannedHeads(g).length;
  }, 0);
}
function checkedCountAt(tableName) {
  return headsAt(tableName).filter(function (h) { return h.checked; }).length;
}
function unseatedGroups() {
  return guests.filter(function (g) {
    if (isDeclined(g)) return false;
    if (!g.table) return true;
    return !tableByName(g.table);
  });
}
function totalPlanned() {
  return guests.reduce(function (a, g) { return a + plannedHeads(g).length; }, 0);
}
function totalChecked() {
  return guests.reduce(function (a, g) {
    var heads = plannedHeads(g);
    for (var i = 0; i < heads.length; i++) if (isChecked(g.code, i)) a++;
    return a;
  }, 0);
}

// POC LOCAL: seating changes stay on this device (Sheet never written).
function assignTable(code, newTableName) {
  var i = guests.findIndex(function (g) { return normCode(g.code) === normCode(code); });
  if (i < 0) return;
  guests[i] = Object.assign({}, guests[i], { table: newTableName });
  var seatMap = loadMap(LS_SEAT);
  seatMap[normCode(code)] = newTableName;
  saveMap(LS_SEAT, seatMap);
  try { localStorage.setItem(LS_GUESTS, JSON.stringify(guests)); } catch (e) {}
  render();
  setSyncMsg("POC: " + esc(guests[i].name) + " → " + esc(newTableName || "(unseated)") + " (local only, Sheet untouched).", true);
}
function setSyncMsg(html, ok, isErr) {
  var el = document.getElementById("syncMsg");
  if (!el) return;
  if (!html) { el.innerHTML = ""; return; }
  el.innerHTML = '<div class="' + (isErr ? "error" : ok ? "success" : "notice") + '">' + html + "</div>";
}

// ---------- rendering ----------
function statusPill(s) {
  if (s === "attending") return '<span class="pill ok">Attending</span>';
  if (s === "declined") return '<span class="pill no">Declined</span>';
  return '<span class="pill wait">Pending</span>';
}
function sideBadge(side) {
  if (String(side).toLowerCase() === "bride") return "B";
  if (String(side).toLowerCase() === "groom") return "G";
  return "•";
}
function sideClass(side) {
  var s = String(side).toLowerCase();
  if (s === "bride") return "side-bride";
  if (s === "groom") return "side-groom";
  return "";
}

function render() {
  renderStats();
  renderFloor();
  renderDetail();
  renderUnseated();
}

function renderStats() {
  var capacity = tables.reduce(function (a, t) { return a + (t.seats || 0); }, 0);
  var planned = totalPlanned();
  var checked = totalChecked();
  var unGroups = unseatedGroups();
  var unHeads = unGroups.reduce(function (a, g) { return a + plannedHeads(g).length; }, 0);
  var badge = '<span class="pill wait">POC • LOCAL</span>';
  document.getElementById("stats").innerHTML =
    '<div class="stat"><b>' + tables.length + '</b><span>Tables × ' + defSeats() + '</span></div>' +
    '<div class="stat"><b>' + capacity + '</b><span>Total seats</span></div>' +
    '<div class="stat"><b>' + planned + '</b><span>Planned heads</span></div>' +
    '<div class="stat"><b style="color:var(--ok)">' + checked + ' / ' + planned + '</b><span>Checked-in (green)</span></div>' +
    '<div class="stat"><b>' + unGroups.length + ' / ' + unHeads + '</b><span>Unseated groups / heads</span></div>' +
    '<div class="stat">' + badge + '<span>' + (loading ? "Loading…" : syncError ? "Sheet error: " + esc(syncError) : "Sheet read-only • plan local") + '</span></div>';
}

function renderFloor() {
  var floor = document.getElementById("floor");
  Array.prototype.slice.call(floor.querySelectorAll(".table-node")).forEach(function (n) { n.remove(); });
  tables.forEach(function (t) {
    var heads = headsAt(t.name);
    var used = heads.length;
    var checked = heads.filter(function (h) { return h.checked; }).length;
    var over = used > t.seats;
    var el = document.createElement("div");
    el.className = "table-node " + t.shape + (over ? " over" : "") + (t.id === selectedTableId ? " selected" : "");
    el.style.left = t.x + "px";
    el.style.top = t.y + "px";
    el.dataset.tid = t.id;

    var center = document.createElement("div");
    center.innerHTML = '<div class="tname">' + esc(t.name) + '</div>' +
      '<div class="tcap">' + used + ' / ' + t.seats + (over ? ' OVER' : '') + (checked ? ' • <b style="color:var(--ok)">' + checked + ' ✓</b>' : '') + '</div>';
    el.appendChild(center);

    var ring = document.createElement("div");
    ring.className = "seats-ring";
    var shown = heads.slice(0, t.seats);
    shown.forEach(function (h) {
      var d = document.createElement("div");
      d.className = "seat " + sideClass(h.side) + (h.checked ? " checked" : "");
      d.textContent = h.checked ? "✓" : sideBadge(h.side);
      d.title = h.label + " (" + h.side + ", " + h.status + ") — tap to " + (h.checked ? "uncheck" : "check in");
      d.addEventListener("click", function (ev) {
        ev.stopPropagation();
        toggleCheckin(h.code, h.headIdx);
      });
      ring.appendChild(d);
    });
    for (var e = shown.length; e < t.seats; e++) {
      var emp = document.createElement("div");
      emp.className = "seat empty";
      emp.textContent = "+";
      emp.title = "Empty seat";
      ring.appendChild(emp);
    }
    if (used > t.seats) {
      var more = document.createElement("div");
      more.className = "seat more";
      more.textContent = "+" + (used - t.seats);
      more.title = (used - t.seats) + " more heads over capacity";
      ring.appendChild(more);
    }
    el.appendChild(ring);

    var editBtn = document.createElement("button");
    editBtn.className = "tedit";
    editBtn.textContent = "✎";
    editBtn.title = "Edit table";
    editBtn.onclick = function (ev) { ev.stopPropagation(); openModal(t.id); };
    el.appendChild(editBtn);
    el.addEventListener("click", function () { selectedTableId = t.id; renderFloor(); renderDetail(); });
    el.addEventListener("dblclick", function () { openModal(t.id); });
    enableDrag(el, t);
    floor.appendChild(el);
  });
}

function enableDrag(el, t) {
  el.addEventListener("pointerdown", function (ev) {
    if (ev.target.classList && (ev.target.classList.contains("tedit") || ev.target.classList.contains("seat"))) return;
    ev.preventDefault();
    var floor = document.getElementById("floor").getBoundingClientRect();
    var ox = ev.clientX - (floor.left + t.x);
    var oy = ev.clientY - (floor.top + t.y);
    if (el.setPointerCapture && ev.pointerId !== undefined) { try { el.setPointerCapture(ev.pointerId); } catch (e) {} }
    selectedTableId = t.id;
    function move(e) {
      var fr = document.getElementById("floor").getBoundingClientRect();
      t.x = Math.max(0, Math.min(Math.max(0, fr.width - 60), Math.round(e.clientX - fr.left - ox)));
      t.y = Math.max(0, Math.min(700, Math.round(e.clientY - fr.top - oy)));
      el.style.left = t.x + "px";
      el.style.top = t.y + "px";
    }
    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      saveTables();
      renderDetail();
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

function tableOptions(selected) {
  return tables.map(function (t) {
    return '<option value="' + esc(t.name) + '"' + (normName(t.name) === normName(selected) ? " selected" : "") + ">" + esc(t.name) + " (" + plannedCountAt(t.name) + "/" + t.seats + ")</option>";
  }).join("");
}

function renderDetail() {
  var title = document.getElementById("detailTitle");
  var body = document.getElementById("detailBody");
  var t = selectedTableId ? tableById(selectedTableId) : null;
  if (!t) {
    title.textContent = "Select a table";
    body.innerHTML = '<p class="muted">Click a table on the floor plan to see its per-head seats. Tap a seat dot to check in (green).</p>';
    return;
  }
  var heads = headsAt(t.name);
  var checked = heads.filter(function (h) { return h.checked; }).length;
  var over = heads.length > t.seats;
  title.textContent = t.name + " — " + heads.length + "/" + t.seats + " heads" + (checked ? " • " + checked + " ✓" : "");
  var html = '<p class="muted" style="font-size:13px">' + esc(t.shape) + " • 6-seat POC" + (t.notes ? " • " + esc(t.notes) : "") +
    ' • <a href="#" id="editTableLink">Edit</a></p>' +
    '<div class="capbar' + (over ? " over" : "") + '"><i style="width:' + (t.seats ? Math.min(100, Math.round(heads.length / t.seats * 100)) : 0) + '%"></i></div>' +
    (over ? '<div class="error">Over capacity by ' + (heads.length - t.seats) + ' head(s).</div>' : '');
  if (!heads.length) html += '<p class="muted">No heads seated here yet — assign a group from Unseated.</p>';
  // group heads by guest code for move/unseat controls
  var byCode = {};
  heads.forEach(function (h) {
    (byCode[h.code] = byCode[h.code] || []).push(h);
  });
  Object.keys(byCode).forEach(function (code) {
    var grp = byCode[code];
    var g = guests.find(function (x) { return normCode(x.code) === normCode(code); });
    html += '<div class="guest-card"><b>' + esc(grp[0].guest) + '</b> ' + statusPill(g ? g.status : "pending") +
      '<div class="meta">' + esc(code) + ' • ' + grp.length + ' head(s) • ' + esc(grp[0].side) + '</div>';
    grp.forEach(function (h) {
      html += '<div class="head-row' + (h.checked ? " checked" : "") + '">' +
        '<span class="seat demo ' + sideClass(h.side) + (h.checked ? " checked" : "") + '" style="width:22px;height:22px;font-size:10px">' + (h.checked ? "✓" : sideBadge(h.side)) + '</span>' +
        '<span class="who">' + esc(h.label) + '</span>' +
        '<button class="checkbtn' + (h.checked ? " on" : "") + '" data-check="' + esc(h.code) + ':' + h.headIdx + '">' + (h.checked ? "✓ In" : "Check in") + '</button></div>';
    });
    html += '<div class="actions"><select data-move="' + esc(code) + '">' + tableOptions(t.name) + '</select>' +
      '<button class="btn small ghost" data-unseat="' + esc(code) + '">Unseat</button></div></div>';
  });
  body.innerHTML = html;
  var et = document.getElementById("editTableLink");
  if (et) et.onclick = function (e) { e.preventDefault(); openModal(t.id); };
  Array.prototype.forEach.call(body.querySelectorAll("[data-check]"), function (b) {
    b.onclick = function () {
      var parts = b.getAttribute("data-check").split(":");
      toggleCheckin(parts[0], parseInt(parts[1], 10) || 0);
    };
  });
  Array.prototype.forEach.call(body.querySelectorAll("[data-unseat]"), function (b) {
    b.onclick = function () { assignTable(b.getAttribute("data-unseat"), ""); };
  });
  Array.prototype.forEach.call(body.querySelectorAll("[data-move]"), function (sel) {
    sel.onchange = function () { assignTable(sel.getAttribute("data-move"), sel.value); };
  });
}

function renderUnseated() {
  var box = document.getElementById("unseated");
  var qEl = document.getElementById("q");
  var q = normName(qEl ? qEl.value : "");
  var qc = normCode(qEl ? qEl.value : "");
  var side = document.getElementById("fSide") ? document.getElementById("fSide").value : "";
  var stf = document.getElementById("fStatus") ? document.getElementById("fStatus").value : "";
  var list = unseatedGroups().filter(function (g) {
    if (side && g.side !== side) return false;
    if (stf === "attending" && !isAttending(g)) return false;
    if (stf === "pending" && g.status !== "pending") return false;
    if (stf === "declined" && !isDeclined(g)) return false;
    if (!stf || stf === "") { if (isDeclined(g)) return false; }
    if (q && !(normCode(g.code).indexOf(qc) >= 0 || normName(g.name).indexOf(q) >= 0 || normName(g.table || "").indexOf(q) >= 0)) return false;
    return true;
  });
  var heads = list.reduce(function (a, g) { return a + plannedHeads(g).length; }, 0);
  document.getElementById("unseatedCount").textContent = heads;
  if (!list.length) {
    box.innerHTML = '<p class="muted">All clear — every head is seated.</p>';
    return;
  }
  var sel = selectedTableId ? tableById(selectedTableId) : null;
  box.innerHTML = "";
  var frag = document.createDocumentFragment();
  list.slice(0, 150).forEach(function (g) {
    var hs = plannedHeads(g);
    var d = document.createElement("div");
    d.className = "guest-card";
    d.innerHTML = '<b>' + esc(g.name) + '</b> ' + statusPill(g.status) +
      '<div class="meta">' + esc(g.code) + ' • ' + hs.length + ' head(s): ' + esc(hs.join(", ")) + ' • ' + esc(g.side) +
      (g.table ? ' • was: ' + esc(g.table) : '') + '</div>' +
      '<div class="actions"></div>';
    var act = d.querySelector(".actions");
    if (sel) {
      var b = document.createElement("button");
      b.className = "btn small";
      b.textContent = "→ " + sel.name;
      b.onclick = function () { assignTable(g.code, sel.name); };
      act.appendChild(b);
    }
    var s2 = document.createElement("select");
    s2.innerHTML = '<option value="">Choose table…</option>' + tableOptions(g.table);
    s2.onchange = function () { if (s2.value) assignTable(g.code, s2.value); };
    act.appendChild(s2);
    frag.appendChild(d);
  });
  box.appendChild(frag);
  if (list.length > 150) {
    var p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Showing 150 of " + list.length + " — refine search.";
    box.appendChild(p);
  }
}

// ---------- table modal ----------
var editingId = null;
function openModal(id) {
  editingId = id || null;
  var t = id ? tableById(id) : null;
  document.getElementById("mTitle").textContent = t ? "Edit " + t.name : "Add table";
  document.getElementById("mName").value = t ? t.name : nextTableName();
  document.getElementById("mSeats").value = t ? t.seats : defSeats();
  document.getElementById("mShape").value = t ? t.shape : "round";
  document.getElementById("mNotes").value = t ? (t.notes || "") : "";
  document.getElementById("mMsg").innerHTML = "";
  document.getElementById("mDelete").style.display = t ? "inline-block" : "none";
  document.getElementById("modal").style.display = "flex";
}
function closeModal() {
  document.getElementById("modal").style.display = "none";
  editingId = null;
}
function nextTableName() {
  var max = 0;
  tables.forEach(function (t) {
    var m = /table\s*(\d+)/i.exec(t.name || "");
    if (m) max = Math.max(max, parseInt(m[1], 10) || 0);
  });
  return "Table " + (max + 1);
}

// ---------- wiring ----------
function init() {
  loadTables();
  guests = applySeatingOverlay(loadLocalGuests());

  var authed = false;
  try { authed = sessionStorage.getItem(SS_AUTH) === "1"; } catch (e) {}
  if (authed) showDash();
  else document.getElementById("dash").style.display = "none";

  document.getElementById("loginBtn").onclick = function () {
    var v = document.getElementById("pw").value;
    if (v === window.ADMIN_PW) {
      try { sessionStorage.setItem(SS_AUTH, "1"); } catch (e) {}
      showDash();
    } else {
      document.getElementById("loginMsg").innerHTML = '<div class="error">Wrong password.</div>';
    }
  };
  document.getElementById("pw").addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("loginBtn").click();
  });

  document.getElementById("addTableBtn").onclick = function () { openModal(null); };
  document.getElementById("mCancel").onclick = closeModal;
  document.getElementById("modal").addEventListener("click", function (e) {
    if (e.target.id === "modal") closeModal();
  });
  document.getElementById("mSave").onclick = function () {
    var msg = document.getElementById("mMsg");
    var name = document.getElementById("mName").value.trim().replace(/\s+/g, " ");
    var seats = Math.max(1, Math.min(40, parseInt(document.getElementById("mSeats").value, 10) || 0));
    var shape = document.getElementById("mShape").value;
    var notes = document.getElementById("mNotes").value.trim();
    if (!name) { msg.innerHTML = '<div class="error">Table name is required.</div>'; return; }
    if (shape !== "round" && shape !== "rect" && shape !== "long") shape = "round";
    var dupe = tables.find(function (t) { return normName(t.name) === normName(name) && t.id !== editingId; });
    if (dupe) { msg.innerHTML = '<div class="error">A table named "' + esc(name) + '" already exists.</div>'; return; }
    if (editingId) {
      var t = tableById(editingId);
      if (!t) return;
      var oldName = t.name;
      t.name = name; t.seats = seats; t.shape = shape; t.notes = notes;
      if (normName(oldName) !== normName(name)) {
        guests.forEach(function (g) {
          if (normName(g.table || "") === normName(oldName)) g.table = name;
        });
        var seatMap = loadMap(LS_SEAT);
        Object.keys(seatMap).forEach(function (k) {
          if (normName(seatMap[k] || "") === normName(oldName)) seatMap[k] = name;
        });
        saveMap(LS_SEAT, seatMap);
      }
      selectedTableId = t.id;
    } else {
      var nt = { id: uid(), name: name, shape: shape, seats: seats, x: 60 + (tables.length % 4) * 200, y: 80 + Math.floor(tables.length / 4) * 160, notes: notes };
      tables.push(nt);
      selectedTableId = nt.id;
    }
    saveTables();
    closeModal();
    render();
  };
  document.getElementById("mDelete").onclick = function () {
    var t = editingId ? tableById(editingId) : null;
    if (!t) return;
    if (!confirm('Delete "' + t.name + '"? Seated heads become Unseated (local only).')) return;
    tables = tables.filter(function (x) { return x.id !== t.id; });
    if (selectedTableId === t.id) selectedTableId = null;
    saveTables();
    closeModal();
    var seatMap = loadMap(LS_SEAT);
    var n = 0;
    guests.forEach(function (g) {
      if (normName(g.table || "") === normName(t.name)) { g.table = ""; seatMap[normCode(g.code)] = ""; n++; }
    });
    saveMap(LS_SEAT, seatMap);
    render();
    setSyncMsg('Deleted "' + esc(t.name) + '" — ' + n + ' group(s) unseated (local only).', true);
  };

  var qEl = document.getElementById("q");
  var deb = null;
  if (qEl) qEl.oninput = function () { clearTimeout(deb); deb = setTimeout(function () { renderUnseated(); }, 120); };
  document.getElementById("fSide").onchange = renderUnseated;
  document.getElementById("fStatus").onchange = renderUnseated;
  document.getElementById("refreshBtn").onclick = function () {
    if (confirm("Reload guest list from Sheet? Your POC seating/check-ins on this device are kept.")) refresh();
  };
  document.getElementById("resetCheckinBtn").onclick = resetCheckins;
  var nr = document.getElementById("navRefresh");
  if (nr) nr.onclick = function (e) { e.preventDefault(); if (sessionAuthed()) refresh(); };
  var ne = document.getElementById("navExport");
  if (ne) ne.onclick = function (e) { e.preventDefault(); exportLayout(); };

  document.getElementById("exportBtn").onclick = exportLayout;
  document.getElementById("importBtn").onclick = function () { document.getElementById("importFile").click(); };
  document.getElementById("importFile").onchange = function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var parsed = JSON.parse(r.result);
        // support both legacy [tables] and POC {tables, seating, checkins}
        var arr = Array.isArray(parsed) ? parsed : parsed.tables;
        if (!Array.isArray(arr)) throw new Error("not a layout file");
        tables = arr.map(sanitizeTable).filter(Boolean);
        if (!tables.length) throw new Error("no valid tables");
        if (parsed && !Array.isArray(parsed) && parsed.seating) saveMap(LS_SEAT, parsed.seating);
        if (parsed && !Array.isArray(parsed) && parsed.checkins) saveMap(LS_CHECKIN, parsed.checkins);
        guests = applySeatingOverlay(guests);
        saveTables();
        render();
        setSyncMsg("Imported " + tables.length + " table(s).", true);
      } catch (err) {
        setSyncMsg("Import failed: " + esc(String((err && err.message) || err)), false, true);
      }
      e.target.value = "";
    };
    r.readAsText(f);
  };
}
function sessionAuthed() {
  try { return sessionStorage.getItem(SS_AUTH) === "1"; } catch (e) { return false; }
}
function exportLayout() {
  var payload = {
    exportedAt: new Date().toISOString(),
    tables: tables,
    seating: loadMap(LS_SEAT),
    checkins: loadMap(LS_CHECKIN)
  };
  var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "rsvp-tables-poc.json";
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
async function showDash() {
  document.getElementById("loginCard").style.display = "none";
  document.getElementById("dash").style.display = "block";
  render();
  await refresh();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
})();
