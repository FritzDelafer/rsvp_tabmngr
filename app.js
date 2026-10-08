// rsvp_wed_tab — visual table / floor-plan manager.
// Guests <-> same Google Sheet GuestList as wedding-rsvp-v2 (TABLE column).
// Tables (layout) <-> localStorage + JSON export/import.
(function () {
"use strict";

var LS_TABLES = "rsvp-tab-tables-v1";
var LS_GUESTS = "rsvp-tab-guests-v1";
var SS_AUTH = "rsvp-tab-admin";

var tables = [];
var guests = []; // normalized guest rows from Sheet
var selectedTableId = null;
var loading = false;
var syncError = "";

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function normCode(s) { return window.normCode ? window.normCode(s) : String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function normName(s) { return window.normName ? window.normName(s) : String(s || "").toLowerCase().trim().replace(/\s+/g, " "); }
function seatsUsed(g) { return window.seatsUsed ? window.seatsUsed(g) : 0; }
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

// ---------- tables persistence ----------
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
  // merge any table names found on seed guests but missing from layout
  var names = {};
  tables.forEach(function (t) { names[normName(t.name)] = 1; });
  (window.SEED_GUESTS || []).forEach(function (g) {
    var tn = String(g.table || "").trim();
    if (tn && !names[normName(tn)]) {
      names[normName(tn)] = 1;
      tables.push({ id: uid(), name: tn, shape: "round", seats: 8, x: 40 + (tables.length % 4) * 220, y: 480, notes: "auto" });
    }
  });
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
    seats: Math.max(1, Math.min(40, parseInt(t.seats, 10) || 8)),
    x: Math.max(0, Math.min(1200, parseInt(t.x, 10) || 0)),
    y: Math.max(0, Math.min(1200, parseInt(t.y, 10) || 0)),
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

// ---------- guests ----------
function loadLocalGuests() {
  try {
    var raw = localStorage.getItem(LS_GUESTS);
    if (raw) return JSON.parse(raw).map(normalizeGuest);
  } catch (e) {}
  return (window.SEED_GUESTS || []).map(normalizeGuest);
}
function isAttending(g) { return g.status === "attending"; }
function isDeclined(g) { return g.status === "declined"; }

async function refresh() {
  loading = true; syncError = ""; render();
  try {
    if (useGas()) {
      var res = await window.gasGet({ action: "list" });
      if (!res || !res.ok) throw new Error((res && res.error) || "list failed");
      guests = (res.guests || []).map(normalizeGuest);
      try { localStorage.setItem(LS_GUESTS, JSON.stringify(guests)); } catch (e) {}
      // auto-add layout rows for TABLE names that exist on Sheet but not in layout
      var known = {};
      tables.forEach(function (t) { known[normName(t.name)] = 1; });
      var added = false;
      guests.forEach(function (g) {
        if (g.table && !known[normName(g.table)]) {
          known[normName(g.table)] = 1;
          tables.push({ id: uid(), name: g.table, shape: "round", seats: 8, x: 40 + (tables.length % 4) * 220, y: 480, notes: "auto from Sheet" });
          added = true;
        }
      });
      if (added) saveTables();
    } else {
      guests = loadLocalGuests();
    }
  } catch (err) {
    syncError = String((err && err.message) || err);
    guests = loadLocalGuests();
  } finally {
    loading = false;
    render();
  }
}

function guestsAt(tableName) {
  var n = normName(tableName);
  return guests.filter(function (g) {
    return !isDeclined(g) && normName(g.table || "") === n;
  });
}
function usedSeatsAt(tableName) {
  return guestsAt(tableName).reduce(function (a, g) { return a + seatsUsed(g); }, 0);
}
function unseatedGuests() {
  return guests.filter(function (g) {
    if (isDeclined(g)) return false;
    if (!g.table) return true;
    return !tableByName(g.table);
  });
}

// Push a single TABLE change to the Sheet (full upsert — backend requires all cols).
async function assignTable(code, newTableName) {
  var i = guests.findIndex(function (g) { return normCode(g.code) === normCode(code); });
  if (i < 0) return;
  var prev = guests[i].table;
  guests[i] = Object.assign({}, guests[i], { table: newTableName });
  render();
  setSyncMsg("Saving " + guests[i].name + " → " + (newTableName || "(unseated)") + "…");
  if (!useGas()) {
    try { localStorage.setItem(LS_GUESTS, JSON.stringify(guests)); } catch (e) {}
    setSyncMsg("Saved locally (no Sheet URL).");
    return;
  }
  try {
    var res = await window.gasPost({ action: "upsert", guest: guests[i] });
    if (!res || !res.ok) throw new Error((res && res.error) || "save failed");
    try { localStorage.setItem(LS_GUESTS, JSON.stringify(guests)); } catch (e) {}
    setSyncMsg("Saved " + guests[i].name + " → " + (newTableName || "(unseated)") + ".", true);
  } catch (e) {
    guests[i] = Object.assign({}, guests[i], { table: prev });
    render();
    setSyncMsg("Save failed for " + code + ": " + esc(String((e && e.message) || e)), false, true);
  }
  render();
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

function render() {
  renderStats();
  renderFloor();
  renderDetail();
  renderUnseated();
}

function renderStats() {
  var attending = guests.filter(isAttending);
  var seatedHeadcount = 0, seatedGroups = 0;
  tables.forEach(function (t) {
    var gs = guestsAt(t.name);
    if (gs.length) seatedGroups++;
    seatedHeadcount += gs.reduce(function (a, g) { return a + seatsUsed(g); }, 0);
  });
  var unseated = unseatedGuests();
  var unseatedHeadcount = unseated.reduce(function (a, g) { return a + Math.max(seatsUsed(g), 1); }, 0);
  var capacity = tables.reduce(function (a, t) { return a + (t.seats || 0); }, 0);
  var attendingHeadcount = attending.reduce(function (a, g) { return a + seatsUsed(g); }, 0);
  var badge = useGas()
    ? '<span class="pill ok">LIVE • Sheet</span>'
    : '<span class="pill wait">LOCAL DEMO</span>';
  document.getElementById("stats").innerHTML =
    '<div class="stat"><b>' + tables.length + '</b><span>Tables</span></div>' +
    '<div class="stat"><b>' + capacity + '</b><span>Total seats</span></div>' +
    '<div class="stat"><b>' + seatedHeadcount + '</b><span>Seated headcount</span></div>' +
    '<div class="stat"><b>' + unseated.length + ' / ' + unseatedHeadcount + '</b><span>Unseated groups / heads</span></div>' +
    '<div class="stat"><b>' + attendingHeadcount + '</b><span>Attending headcount</span></div>' +
    '<div class="stat">' + badge + '<span>' + (loading ? "Loading…" : syncError ? "Sheet error: " + esc(syncError) : seatedGroups + " tables occupied") + '</span></div>';
}

function renderFloor() {
  var floor = document.getElementById("floor");
  // remove old nodes (keep hint)
  Array.prototype.slice.call(floor.querySelectorAll(".table-node")).forEach(function (n) { n.remove(); });
  tables.forEach(function (t) {
    var used = usedSeatsAt(t.name);
    var pct = t.seats ? Math.min(100, Math.round(used / t.seats * 100)) : 0;
    var over = used > t.seats;
    var el = document.createElement("div");
    el.className = "table-node " + t.shape + (over ? " over" : "") + (t.id === selectedTableId ? " selected" : "");
    el.style.left = t.x + "px";
    el.style.top = t.y + "px";
    el.dataset.tid = t.id;
    el.innerHTML =
      '<div class="tname">' + esc(t.name) + '</div>' +
      '<div class="tcap">' + used + ' / ' + t.seats + (over ? ' OVER' : '') + ' • ' + guestsAt(t.name).length + ' groups</div>' +
      '<div class="tbar"><i style="width:' + pct + '%"></i></div>' +
      (t.notes ? '<div class="tcap">' + esc(t.notes) + '</div>' : '');
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
    if (ev.target.classList && ev.target.classList.contains("tedit")) return;
    ev.preventDefault();
    var floor = document.getElementById("floor").getBoundingClientRect();
    var ox = ev.clientX - (floor.left + t.x);
    var oy = ev.clientY - (floor.top + t.y);
    el.setPointerCapture && el.setPointerCapture(ev.pointerId);
    selectedTableId = t.id;
    function move(e) {
      var fr = document.getElementById("floor").getBoundingClientRect();
      t.x = Math.max(0, Math.min(fr.width - 60, Math.round(e.clientX - fr.left - ox)));
      t.y = Math.max(0, Math.min(600, Math.round(e.clientY - fr.top - oy)));
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
    return '<option value="' + esc(t.name) + '"' + (normName(t.name) === normName(selected) ? " selected" : "") + ">" + esc(t.name) + " (" + usedSeatsAt(t.name) + "/" + t.seats + ")</option>";
  }).join("");
}

function renderDetail() {
  var title = document.getElementById("detailTitle");
  var body = document.getElementById("detailBody");
  var t = selectedTableId ? tableById(selectedTableId) : null;
  if (!t) {
    title.textContent = "Select a table";
    body.innerHTML = '<p class="muted">Click a table on the floor plan to see its guests.</p>';
    return;
  }
  var gs = guestsAt(t.name);
  var used = gs.reduce(function (a, g) { return a + seatsUsed(g); }, 0);
  var over = used > t.seats;
  title.textContent = t.name + " — " + used + "/" + t.seats + " seats";
  var html = '<p class="muted" style="font-size:13px">' + esc(t.shape) + (t.notes ? " • " + esc(t.notes) : "") +
    ' • <a href="#" id="editTableLink">Edit</a></p>' +
    '<div class="capbar' + (over ? " over" : "") + '"><i style="width:' + (t.seats ? Math.min(100, Math.round(used / t.seats * 100)) : 0) + '%"></i></div>' +
    (over ? '<div class="error">Over capacity by ' + (used - t.seats) + ' seat(s).</div>' : '');
  if (!gs.length) html += '<p class="muted">No guests seated here yet — assign from Unseated.</p>';
  gs.forEach(function (g) {
    html += '<div class="guest-card"><b>' + esc(g.name) + '</b> ' + statusPill(g.status) +
      '<div class="meta">' + esc(g.code) + ' • pax ' + g.pax + ' • uses ' + seatsUsed(g) +
      (g.companions && g.companions.length ? " • +" + esc(g.companions.join("; ")) : "") + ' • ' + esc(g.side) + '</div>' +
      '<div class="actions"><select data-move="' + esc(g.code) + '">' + tableOptions(t.name) + '</select>' +
      '<button class="btn small ghost" data-unseat="' + esc(g.code) + '">Unseat</button></div></div>';
  });
  body.innerHTML = html;
  var et = document.getElementById("editTableLink");
  if (et) et.onclick = function (e) { e.preventDefault(); openModal(t.id); };
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
  var list = unseatedGuests().filter(function (g) {
    if (side && g.side !== side) return false;
    if (stf === "attending" && !isAttending(g)) return false;
    if (stf === "pending" && g.status !== "pending") return false;
    if (stf === "declined" && !isDeclined(g)) return false;
    if (!stf || stf === "") { if (isDeclined(g)) return false; }
    if (stf === "all") { /* no status filter */ }
    if (q && !(normCode(g.code).indexOf(qc) >= 0 || normName(g.name).indexOf(q) >= 0 || normName(g.table || "").indexOf(q) >= 0)) return false;
    return true;
  });
  document.getElementById("unseatedCount").textContent = list.length;
  if (!list.length) {
    box.innerHTML = '<p class="muted">All clear — everyone is seated.</p>';
    return;
  }
  var sel = selectedTableId ? tableById(selectedTableId) : null;
  box.innerHTML = "";
  var frag = document.createDocumentFragment();
  list.slice(0, 150).forEach(function (g) {
    var d = document.createElement("div");
    d.className = "guest-card";
    d.innerHTML = '<b>' + esc(g.name) + '</b> ' + statusPill(g.status) +
      '<div class="meta">' + esc(g.code) + ' • pax ' + g.pax + ' • uses ' + Math.max(seatsUsed(g), 1) + ' • ' + esc(g.side) +
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
  document.getElementById("mSeats").value = t ? t.seats : 8;
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
  guests = loadLocalGuests();

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
      // rename: keep seated guests pointing at the new name locally
      if (normName(oldName) !== normName(name)) {
        guests.forEach(function (g) {
          if (normName(g.table || "") === normName(oldName)) g.table = name;
        });
        setSyncMsg('Renamed "' + esc(oldName) + '" → "' + esc(name) + '". Re-assign guests to push the new name to the Sheet.');
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
  document.getElementById("mDelete").onclick = async function () {
    var t = editingId ? tableById(editingId) : null;
    if (!t) return;
    if (!confirm('Delete "' + t.name + '"? Seated guests become Unseated.')) return;
    tables = tables.filter(function (x) { return x.id !== t.id; });
    if (selectedTableId === t.id) selectedTableId = null;
    saveTables();
    closeModal();
    // unseat its guests (local first, push each to Sheet)
    var affected = guests.filter(function (g) { return normName(g.table || "") === normName(t.name); });
    affected.forEach(function (g) { g.table = ""; });
    render();
    if (useGas() && affected.length) {
      setSyncMsg("Pushing " + affected.length + " unseated guest(s) to Sheet…");
      for (var k = 0; k < affected.length; k++) {
        try { await window.gasPost({ action: "upsert", guest: affected[k] }); }
        catch (e) { setSyncMsg("Delete done locally, but Sheet push failed: " + esc(String((e && e.message) || e)), false, true); break; }
      }
      try { localStorage.setItem(LS_GUESTS, JSON.stringify(guests)); } catch (e) {}
      setSyncMsg('Deleted "' + esc(t.name) + '" — ' + affected.length + ' guest(s) unseated.', true);
      render();
    }
  };

  var qEl = document.getElementById("q");
  var deb = null;
  if (qEl) qEl.oninput = function () { clearTimeout(deb); deb = setTimeout(function () { renderUnseated(); }, 120); };
  document.getElementById("fSide").onchange = renderUnseated;
  document.getElementById("fStatus").onchange = renderUnseated;
  document.getElementById("refreshBtn").onclick = refresh;
  var nr = document.getElementById("navRefresh");
  if (nr) nr.onclick = function (e) { e.preventDefault(); if (authed || sessionAuthed()) refresh(); };
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
        var arr = JSON.parse(r.result);
        if (!Array.isArray(arr)) throw new Error("not an array");
        tables = arr.map(sanitizeTable).filter(Boolean);
        if (!tables.length) throw new Error("no valid tables");
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
  var blob = new Blob([JSON.stringify(tables, null, 2)], { type: "application/json" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "rsvp-tables-layout.json";
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
