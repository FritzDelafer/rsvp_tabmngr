// rsvp_wed_tab — shared config + GAS helpers.
// Mirrors wedding-rsvp-v2 data.js so both projects talk to the SAME sheet.
window.GAS_URL = "https://script.google.com/macros/s/AKfycbzqwmcSZ1AspOcdxFRMsNK8bPhn9Jl6Q42k0lyqU2KYnACjbvkYbZzx92fFtzrkVZOI/exec";
window.SHEET_TAB = "GuestList";
window.GAS_KEY = ""; // must match ADMIN_KEY in Code.gs (empty = no key needed)
window.ADMIN_PW = "12192026";
// POC mode: seating plan stays in THIS browser only — nothing is
// written back to the Google Sheet TABLE column (no final seat plan yet).
// CHECKIN *does* sync to the Sheet (GuestList column CHECKIN) so door staff
// share check-ins across devices. TABLE stays local; CHECKIN is shared.
window.POC_LOCAL_ONLY = true;
window.DEFAULT_SEATS = 6;

// CHECKIN helpers (mirror Code.gs): canonical "1,0,1" per-head flags.
window.parseCheckin = function (v) {
  if (Array.isArray(v)) return v.map(function (x) { return !!x; });
  var s = String(v == null ? "" : v).trim();
  if (!s) return [];
  if (/^\d+$/.test(s)) {
    if (s.length === 1) {
      var out = [], n = parseInt(s, 10) || 0;
      for (var i = 0; i < n; i++) out.push(true);
      return out;
    }
    if (/^[01]+$/.test(s)) return s.split("").map(function (c) { return c === "1"; });
  }
  return s.split(/[;,\s\n]+/).map(function (c) {
    var nrm = String(c).trim().toLowerCase();
    return nrm === "1" || nrm === "x" || nrm === "✓" || nrm === "yes" || nrm === "true" || nrm === "checked" || nrm === "in";
  });
};
window.serializeCheckin = function (arr) {
  if (!arr || !arr.length) return "";
  var end = arr.length;
  while (end > 0 && !arr[end - 1]) end--;
  if (end === 0) return "";
  return arr.slice(0, end).map(function (x) { return x ? "1" : "0"; }).join(",");
};

function gasTimeout_(ms) {
  try {
    if (window.AbortSignal && AbortSignal.timeout) return AbortSignal.timeout(ms);
  } catch (e) {}
  return undefined;
}
window.gasGet = async function (params) {
  const qs = new URLSearchParams(params || {}).toString();
  const res = await fetch(window.GAS_URL + (qs ? "?" + qs : ""), { cache: "no-store", signal: gasTimeout_(15000) });
  if (!res.ok) throw new Error("GAS GET failed: " + res.status);
  return res.json();
};
window.gasPost = async function (body) {
  const payload = Object.assign({}, body || {});
  if (window.GAS_KEY) payload.key = window.GAS_KEY;
  const res = await fetch(window.GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
    signal: gasTimeout_(20000),
  });
  if (!res.ok) throw new Error("GAS POST failed: " + res.status);
  return res.json();
};
window.usingGas = function () { return !!(window.GAS_URL && window.GAS_URL.indexOf("/exec") > 0); };

window.normCode = function (s) {
  return String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
};
window.normName = function (s) {
  return String(s == null ? "" : s).toLowerCase().trim().replace(/\s+/g, " ");
};

// Seats a guest occupies: 1 + companions when attending, else 0.
window.seatsUsed = function (g) {
  if (!g) return 0;
  const s = String(g.status || "").toLowerCase();
  if (s === "declined") return 0;
  if (s === "attending" || s === "confirmed") {
    const comps = Array.isArray(g.companions)
      ? g.companions
      : String(g.companions || "").split(/[;,\n]+/).map(function (c) { return c.trim(); }).filter(Boolean);
    return 1 + comps.length;
  }
  return 0;
};

window.SEED_GUESTS = [
  { code: "CF4K7P", name: "Canto Family", pax: 4, side: "Groom", table: "Table 1", status: "pending", companions: [], contact: "", message: "" },
  { code: "AF4M3Q", name: "Adra Family", pax: 4, side: "Bride", table: "Table 2", status: "pending", companions: [], contact: "", message: "" },
  { code: "JO1T8R", name: "Jaira Ondoy", pax: 1, side: "Bride", table: "Table 3", status: "pending", companions: [], contact: "", message: "" },
  { code: "SPC2X4D", name: "Samuel Paul Canto", pax: 2, side: "Groom", table: "Table 4", status: "pending", companions: [], contact: "", message: "" },
  { code: "MPC2J9F", name: "Ma. Pauline Canto", pax: 2, side: "Bride", table: "Table 1", status: "attending", companions: ["John Fritz Delafer"], contact: "9123123123", message: "yeahhh" },
  { code: "JA1Q2W", name: "Joshua Arquiza", pax: 1, side: "Groom", table: "Table 5", status: "declined", companions: [], contact: "", message: "Sorry, can't make it!" },
  { code: "IF3H6N", name: "Ibeas Family", pax: 3, side: "Both", table: "Table 6", status: "pending", companions: [], contact: "", message: "" },
  { code: "HCH2B5V", name: "Hannah Claire Hicks", pax: 2, side: "Both", table: "Table 7", status: "pending", companions: [], contact: "", message: "" }
];

// Default floor layout — 6 seats per table (POC). Matches Table N names in SEED_GUESTS.
window.SEED_TABLES = [
  { id: "t1", name: "Table 1", shape: "round", seats: 6, x: 60,  y: 50,  notes: "VIP" },
  { id: "t2", name: "Table 2", shape: "round", seats: 6, x: 300, y: 50,  notes: "" },
  { id: "t3", name: "Table 3", shape: "round", seats: 6, x: 540, y: 50,  notes: "" },
  { id: "t4", name: "Table 4", shape: "rect",  seats: 6, x: 60, y: 280, notes: "" },
  { id: "t5", name: "Table 5", shape: "rect",  seats: 6, x: 320, y: 280, notes: "" },
  { id: "t6", name: "Table 6", shape: "long",  seats: 6, x: 580, y: 280, notes: "" },
  { id: "t7", name: "Table 7", shape: "round", seats: 6, x: 180, y: 500, notes: "" },
  { id: "t8", name: "Table 8", shape: "round", seats: 6, x: 460, y: 500, notes: "" }
];
