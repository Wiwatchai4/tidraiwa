import { useState, useEffect, useRef, useCallback } from "react";
import { storage } from "./firebase.js";

// ---------- constants ----------
const ADMIN_PASSWORD = "1234"; // prototype-only, replace before real deployment
const COOLDOWN_MS = 15 * 60 * 1000;
const EXPIRE_MS = 20 * 60 * 1000;
const DEFAULT_STATUS = "ทางสะดวก / ไม่มีรายงานรถติด";

// ---------- client-side encryption for stored user records ----------
// IMPORTANT LIMITATION: ADMIN_PASSWORD lives in this client-side code, visible to
// anyone who reads it (e.g. via browser dev tools). This encryption makes casual
// or accidental viewing of stored data meaningless (it looks like random noise),
// but it does NOT stop someone who deliberately reads the source and extracts the
// password — there is no truly private place to hide a secret in client-only code.
// Real access control requires a server that holds the secret and the client never
// does (see prototype limitations).
const ENC_SALT = new TextEncoder().encode("tidraiwa-v1-salt");

async function deriveKey(passphrase) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: ENC_SALT, iterations: 100000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function base64ToBuf(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function encryptJson(obj, passphrase) {
  const key = await deriveKey(passphrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return JSON.stringify({ iv: bufToBase64(iv), data: bufToBase64(cipherBuf) });
}

// Returns the parsed object on success, or null if the passphrase is wrong /
// data is corrupt (AES-GCM auth tag fails) — never throws to the caller.
async function decryptJson(payload, passphrase) {
  try {
    const { iv, data } = JSON.parse(payload);
    const key = await deriveKey(passphrase);
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBuf(iv) },
      key,
      base64ToBuf(data)
    );
    return JSON.parse(new TextDecoder().decode(plainBuf));
  } catch (e) {
    return null;
  }
}

const DIRECTIONS = {
  inbound: { label: "ขาเข้า (มุ่งหน้าดินแดง)", icon: "🏙️" },
  outbound: { label: "ขาออก (มุ่งหน้ารังสิต)", icon: "✈️" },
};

const VEHICLES = [
  { id: "moto", label: "รถจักรยานยนต์ / ไรเดอร์", icon: "🏍️" },
  { id: "car", label: "รถยนต์ส่วนบุคคล", icon: "🚗" },
  { id: "van", label: "รถโดยสารสาธารณะ / รถตู้", icon: "🚌" },
];

// Landmark reference points along Vibhavadi Road, with approximate coordinates.
// These are fixed in code (free) so we never need a paid geocoding API call.
// Ordered south (Din Daeng) -> north (Rangsit / Don Mueang) along the road.
const LANDMARKS = {
  tollway: [
    { id: "tl_dindaeng", name: "ดินแดง", lat: 13.7715, lng: 100.5602 },
    { id: "tl_phahon", name: "อนุสรณ์สถาน", lat: 13.8367, lng: 100.5707 },
    { id: "tl_kaset", name: "แยกเกษตร", lat: 13.8469, lng: 100.5713 },
    { id: "tl_laksi", name: "หลักสี่", lat: 13.8801, lng: 100.5757 },
    { id: "tl_donmueang", name: "ดอนเมือง", lat: 13.9126, lng: 100.6068 },
  ],
  local: [
    { id: "lo_dindaeng", name: "สี่แยกดินแดง", lat: 13.7715, lng: 100.5602 },
    { id: "lo_sutthisan", name: "สุทธิสาร", lat: 13.7945, lng: 100.5663 },
    { id: "lo_ladprao", name: "ลาดพร้าว", lat: 13.8161, lng: 100.5690 },
    { id: "lo_kaset", name: "แยกเกษตร", lat: 13.8469, lng: 100.5713 },
    { id: "lo_laksi", name: "หลักสี่", lat: 13.8801, lng: 100.5757 },
    { id: "lo_donmueang", name: "หน้า ม.เกษตรฯ", lat: 13.8480, lng: 100.5700 },
  ],
};

const STATUS_OPTIONS = [
  { id: "red", color: "red", label: "ติด / รถแน่น" },
  { id: "green", color: "green", label: "โล่ง / ไปได้สบาย" },
];

// Haversine distance in km between two lat/lng points — pure math, no API call.
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Given a user's GPS position and a level (tollway/local), find the nearest
// landmark and, if a second landmark is close in distance, describe the
// position as "between A and B, closer to A" — always rendered as names,
// never raw coordinates.
function describePosition(level, lat, lng) {
  const points = LANDMARKS[level];
  const withDist = points.map((p) => ({ ...p, d: distanceKm(lat, lng, p.lat, p.lng) }));
  withDist.sort((a, b) => a.d - b.d);
  const nearest = withDist[0];
  const second = withDist[1];
  if (!second || nearest.d < 0.5) {
    return { text: `ที่ ${nearest.name}`, nearest, second: null };
  }
  // closer point named first
  return { text: `ช่วง ${nearest.name} ↔ ${second.name} (ใกล้ ${nearest.name} มากกว่า)`, nearest, second };
}

// ---------- small local helpers (per-device, not shared) ----------
function getDeviceId() {
  let id = window.localStorage?.getItem?.("tdrw_device_id");
  if (!id) {
    id = "dev_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      window.localStorage?.setItem?.("tdrw_device_id", id);
    } catch (e) {}
  }
  return id;
}

// fallback in-memory store if localStorage is unavailable
const memoryStore = {};
function localGet(key) {
  try {
    const v = window.localStorage?.getItem?.(key);
    return v === null || v === undefined ? null : v;
  } catch (e) {
    return memoryStore[key] ?? null;
  }
}
function localSet(key, value) {
  try {
    window.localStorage?.setItem?.(key, value);
  } catch (e) {
    memoryStore[key] = value;
  }
}

export default function Tidraiwa() {
  // ---------- app routing state ----------
  const [screen, setScreen] = useState("loading"); // loading | welcome | main
  const [direction, setDirection] = useState("inbound");
  const [selectedLevel, setSelectedLevel] = useState("tollway"); // tollway | local — which road level is shown
  const [user, setUser] = useState(null);
  const deviceId = useRef(getDeviceId());

  // ---------- welcome form state ----------
  const [phone, setPhone] = useState("");
  const [vehicle, setVehicle] = useState(null);
  const [coreConsent, setCoreConsent] = useState(false);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [formError, setFormError] = useState("");

  // ---------- reports state ----------
  // Each level (tollway/local) now holds TWO independent reports: one for the
  // latest "red" (stuck) sighting and one for the latest "green" (clear)
  // sighting. They are reported and expire independently — a "clear at X"
  // report does not overwrite a "stuck at Y" report, since they describe
  // different points on the road that can both be true at once.
  const [reports, setReports] = useState({
    tollway: { red: null, green: null },
    local: { red: null, green: null },
  });
  const [votedIds, setVotedIds] = useState(new Set());
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState("");

  // ---------- report flow state (GPS-first, manual landmark fallback) ----------
  const [reportModal, setReportModal] = useState(null); // { level, statusId } | null
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [autoPosition, setAutoPosition] = useState(null); // { text, nearest, second }
  const [manualLandmarkId, setManualLandmarkId] = useState(null);

  // ---------- admin state ----------
  const [titleTapCount, setTitleTapCount] = useState(0);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminPwInput, setAdminPwInput] = useState("");
  const [adminError, setAdminError] = useState("");
  const [exportStatus, setExportStatus] = useState("");

  const [ttsSupported, setTtsSupported] = useState(true);
  const lastSpokenKey = useRef("");

  // ---------- init: check registration + load reports ----------
  useEffect(() => {
    (async () => {
      const savedUser = localGet("tdrw_user");
      if (savedUser) {
        try {
          setUser(JSON.parse(savedUser));
        } catch (e) {}
      }
      const savedCooldown = localGet("tdrw_cooldown_until");
      if (savedCooldown) setCooldownUntil(parseInt(savedCooldown, 10) || 0);
      const savedVotes = localGet("tdrw_voted_ids");
      if (savedVotes) {
        try {
          setVotedIds(new Set(JSON.parse(savedVotes)));
        } catch (e) {}
      }
      await refreshReports();
      setScreen(savedUser ? "main" : "welcome");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ticking clock for cooldown / expiry display
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // poll shared storage every 8s so multiple users see updates
  useEffect(() => {
    if (screen !== "main") return;
    const t = setInterval(() => {
      refreshReports();
    }, 8000);
    return () => clearInterval(t);
  }, [screen]);

  // auto-expire stale reports locally on each tick (storage is source of truth on refresh)
  useEffect(() => {
    setReports((prev) => {
      let changed = false;
      const next = { tollway: { ...prev.tollway }, local: { ...prev.local } };
      for (const level of ["tollway", "local"]) {
        for (const color of ["red", "green"]) {
          const r = prev[level][color];
          if (r && now - r.timestamp > EXPIRE_MS) {
            next[level][color] = null;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [now]);

  async function refreshReports() {
    try {
      const result = await storage.list("report:");
      const keys = result?.keys || [];
      const byLevel = {
        tollway: { red: null, green: null },
        local: { red: null, green: null },
      };
      for (const k of keys) {
        // key shape: report:<direction>_<level>_<color>
        const rest = k.replace("report:", "");
        if (!rest.startsWith(direction)) continue;
        const level = rest.includes("_tollway_") ? "tollway" : rest.includes("_local_") ? "local" : null;
        const color = rest.endsWith("_red") ? "red" : rest.endsWith("_green") ? "green" : null;
        if (!level || !color) continue;
        try {
          const res = await storage.get(k);
          if (res?.value) {
            const parsed = JSON.parse(res.value);
            if (Date.now() - parsed.timestamp <= EXPIRE_MS) {
              byLevel[level][color] = parsed;
            }
          }
        } catch (e) {}
      }
      setReports(byLevel);
    } catch (e) {
      // storage unavailable; keep local state as-is
    }
  }

  // re-fetch when direction changes
  useEffect(() => {
    if (screen === "main") refreshReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction]);

  // ---------- TTS ----------
  const speak = useCallback(
    (text) => {
      try {
        if (!("speechSynthesis" in window)) {
          setTtsSupported(false);
          return;
        }
        const voices = window.speechSynthesis.getVoices();
        const thaiVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("th"));
        if (!thaiVoice) {
          setTtsSupported(false);
          return; // silent fallback, no error, no blocking UI
        }
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.voice = thaiVoice;
        utter.lang = "th-TH";
        utter.rate = 1.0;
        window.speechSynthesis.speak(utter);
      } catch (e) {
        setTtsSupported(false);
      }
    },
    []
  );

  // Builds a spoken/displayed summary for one level (tollway/local) combining
  // both the latest "stuck" and "clear" reports — they're independent, so
  // both can have something to say at once, or either can be empty.
  function describeLevelStatus(level) {
    const r = reports[level];
    const parts = [];
    if (r.red) parts.push(`ติดที่ ${r.red.position_text}`);
    if (r.green) parts.push(`โล่งที่ ${r.green.position_text}`);
    if (parts.length === 0) return DEFAULT_STATUS;
    return parts.join(" ");
  }

  useEffect(() => {
    if (screen !== "main") return;
    const tollText = describeLevelStatus("tollway");
    const localText = describeLevelStatus("local");
    const key = tollText + "|" + localText + "|" + direction;
    if (key === lastSpokenKey.current) return;
    lastSpokenKey.current = key;
    const announcement = `ติดไรวะรายงานค่ะ ทิศทาง${DIRECTIONS[direction].label} โทลล์เวย์ด้านบน ${tollText} ทางราบด้านล่าง ${localText}`;
    // small delay so voices list is ready
    const t = setTimeout(() => speak(announcement), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reports, direction, screen]);

  // ---------- registration ----------
  async function handleRegister() {
    setFormError("");
    if (!/^[0-9]{9,10}$/.test(phone)) {
      setFormError("กรุณากรอกเบอร์โทรศัพท์ให้ถูกต้อง (9-10 หลัก)");
      return;
    }
    if (!vehicle) {
      setFormError("กรุณาเลือกประเภทยานพาหนะ");
      return;
    }
    if (!coreConsent) {
      setFormError("กรุณายอมรับเงื่อนไขการใช้ข้อมูลก่อนใช้งาน");
      return;
    }
    const userData = {
      phone_number: phone,
      vehicle_type: vehicle,
      register_time: Date.now(),
      marketing_consent: marketingConsent,
      core_consent_time: Date.now(),
      device_id: deviceId.current,
    };
    // Local flag so this device isn't asked to register again.
    localSet("tdrw_user", JSON.stringify(userData));
    // Shared copy (keyed by device id) so admin export can back up all users,
    // per the user's explicit purpose: marketing-contact backup, with PDPA
    // consent already collected above. Each user's record is a separate key,
    // not one shared blob, to avoid concurrent-write conflicts.
    try {
      const encrypted = await encryptJson(userData, ADMIN_PASSWORD);
      await storage.set(`user:${deviceId.current}`, encrypted);
    } catch (e) {
      // Non-fatal: registration still proceeds locally even if the shared
      // backup write fails (e.g. offline). Admin export will simply miss
      // this record until it succeeds on a later run.
    }
    setUser(userData);
    setScreen("main");
  }

  // ---------- reporting ----------
  const cooldownRemaining = Math.max(0, cooldownUntil - now);
  const onCooldown = cooldownRemaining > 0;

  function openReportModal(level, statusId) {
    if (onCooldown) {
      setToast(`ส่งรายงานถี่เกินไป รออีก ${Math.ceil(cooldownRemaining / 60000)} นาที`);
      setTimeout(() => setToast(""), 2500);
      return;
    }
    setReportModal({ level, statusId });
    setAutoPosition(null);
    setManualLandmarkId(null);
    setLocationError("");
    requestGpsPosition(level);
  }

  function requestGpsPosition(level) {
    if (!("geolocation" in navigator)) {
      setLocationError("อุปกรณ์นี้ไม่รองรับการระบุตำแหน่งอัตโนมัติ กรุณาเลือกจุดด้วยตนเอง");
      return;
    }
    setLocating(true);
    setLocationError("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const result = describePosition(level, pos.coords.latitude, pos.coords.longitude);
        setAutoPosition(result);
      },
      (err) => {
        setLocating(false);
        setLocationError("ไม่สามารถระบุตำแหน่งอัตโนมัติได้ กรุณาเลือกจุดด้วยตนเอง");
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }

  function closeReportModal() {
    setReportModal(null);
    setAutoPosition(null);
    setManualLandmarkId(null);
    setLocationError("");
  }

  async function submitReport() {
    if (!reportModal) return;
    const { level, statusId } = reportModal;
    const statusOpt = STATUS_OPTIONS.find((s) => s.id === statusId);
    let positionText;
    if (autoPosition) {
      positionText = autoPosition.text;
    } else if (manualLandmarkId) {
      const lm = LANDMARKS[level].find((l) => l.id === manualLandmarkId);
      positionText = lm ? `ที่ ${lm.name}` : "ไม่ระบุตำแหน่ง";
    } else {
      setToast("กรุณาเลือกตำแหน่งก่อนส่งรายงาน");
      setTimeout(() => setToast(""), 2000);
      return;
    }
    const report = {
      id: statusId + "_" + level + "_" + Date.now(),
      direction,
      level,
      color: statusOpt.color,
      // position_text is just the place name (e.g. "ที่ สุทธิสาร") — the
      // red/green meaning is carried by which key it's stored under, not by
      // this text, so the UI can label it "ติดที่ ..." or "โล่งที่ ..." itself.
      position_text: positionText,
      timestamp: Date.now(),
      device_id: deviceId.current,
      upvotes: 0,
      downvotes: 0,
    };
    try {
      await storage.set(`report:${direction}_${level}_${statusOpt.color}`, JSON.stringify(report));
    } catch (e) {
      setToast("ไม่สามารถบันทึกรายงานได้ ลองใหม่อีกครั้ง");
      setTimeout(() => setToast(""), 2500);
      return;
    }
    setReports((prev) => ({
      ...prev,
      [level]: { ...prev[level], [statusOpt.color]: report },
    }));
    const until = Date.now() + COOLDOWN_MS;
    setCooldownUntil(until);
    localSet("tdrw_cooldown_until", String(until));
    setToast("ส่งรายงานแล้ว ขอบคุณค่ะ");
    setTimeout(() => setToast(""), 2000);
    closeReportModal();
  }

  async function handleVote(level, color, isUp) {
    const report = reports[level][color];
    if (!report) return;
    if (votedIds.has(report.id)) {
      setToast("คุณโหวตรายงานนี้ไปแล้ว");
      setTimeout(() => setToast(""), 2000);
      return;
    }
    const updated = { ...report };
    if (isUp) updated.upvotes = (updated.upvotes || 0) + 1;
    else updated.downvotes = (updated.downvotes || 0) + 1;

    const newVoted = new Set(votedIds);
    newVoted.add(report.id);
    setVotedIds(newVoted);
    localSet("tdrw_voted_ids", JSON.stringify([...newVoted]));

    if (!isUp && updated.downvotes >= 3) {
      try {
        await storage.delete(`report:${direction}_${level}_${color}`);
      } catch (e) {}
      setReports((prev) => ({ ...prev, [level]: { ...prev[level], [color]: null } }));
      setToast("ข้อมูลถูกรีเซ็ตเนื่องจากมีผู้แจ้งว่าไม่ถูกต้อง");
      setTimeout(() => setToast(""), 2500);
      return;
    }
    try {
      await storage.set(`report:${direction}_${level}_${color}`, JSON.stringify(updated));
    } catch (e) {}
    setReports((prev) => ({ ...prev, [level]: { ...prev[level], [color]: updated } }));
  }

  // ---------- admin ----------
  function handleTitleTap() {
    const next = titleTapCount + 1;
    setTitleTapCount(next);
    if (next >= 5) {
      setAdminOpen(true);
      setTitleTapCount(0);
    }
    setTimeout(() => setTitleTapCount(0), 2000);
  }

  function handleAdminSubmit() {
    if (adminPwInput === ADMIN_PASSWORD) {
      setAdminUnlocked(true);
      setAdminError("");
    } else {
      setAdminError("รหัสผ่านไม่ถูกต้อง");
    }
  }

  async function handleResetAll() {
    for (const dir of Object.keys(DIRECTIONS)) {
      for (const level of ["tollway", "local"]) {
        for (const color of ["red", "green"]) {
          try {
            await storage.delete(`report:${dir}_${level}_${color}`);
          } catch (e) {}
        }
      }
    }
    setReports({ tollway: { red: null, green: null }, local: { red: null, green: null } });
    setToast("รีเซ็ตข้อมูลทั้งหมดแล้ว");
    setTimeout(() => setToast(""), 2000);
    setAdminOpen(false);
    setAdminUnlocked(false);
    setAdminPwInput("");
  }

  // Pull every shared "user:*" record, decrypt with the admin passphrase, and
  // build a CSV file for download. This is a manual, on-demand backup (not
  // auto-sync) — admin clicks the button, gets a .csv, then opens/imports it
  // in Google Sheets themselves.
  async function handleExportUsersCsv() {
    setExportStatus("กำลังรวบรวมและถอดรหัสข้อมูล...");
    try {
      const result = await storage.list("user:");
      const keys = result?.keys || [];
      if (keys.length === 0) {
        setExportStatus("ยังไม่มีข้อมูลผู้ใช้ให้ส่งออก");
        setTimeout(() => setExportStatus(""), 2500);
        return;
      }
      const rows = [["phone_number", "vehicle_type", "register_time", "marketing_consent", "device_id"]];
      let failCount = 0;
      for (const k of keys) {
        try {
          const res = await storage.get(k);
          if (res?.value) {
            const u = await decryptJson(res.value, ADMIN_PASSWORD);
            if (!u) {
              failCount++;
              continue; // wrong passphrase or corrupted record — skip, don't crash export
            }
            rows.push([
              u.phone_number || "",
              u.vehicle_type || "",
              u.register_time ? new Date(u.register_time).toISOString() : "",
              u.marketing_consent ? "yes" : "no",
              u.device_id || "",
            ]);
          }
        } catch (e) {
          failCount++;
        }
      }
      if (rows.length === 1) {
        setExportStatus("ถอดรหัสข้อมูลไม่สำเร็จเลย — รหัสผ่านอาจไม่ถูกต้องหรือข้อมูลเสียหาย");
        setTimeout(() => setExportStatus(""), 3000);
        return;
      }
      const csv = rows
        .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
        .join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tidraiwa_users_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      const failNote = failCount > 0 ? ` (ถอดรหัสไม่สำเร็จ ${failCount} รายการ — ข้ามไป)` : "";
      setExportStatus(`ส่งออกแล้ว ${rows.length - 1} รายการ${failNote} — เปิดไฟล์นี้ด้วย Google Sheets (File > Import) ได้เลย`);
      setTimeout(() => setExportStatus(""), 5000);
    } catch (e) {
      setExportStatus("ไม่สามารถส่งออกข้อมูลได้ ลองใหม่อีกครั้ง");
      setTimeout(() => setExportStatus(""), 2500);
    }
  }

  // ---------- styles ----------
  const colors = {
    bg: "#0a0a0a",
    card: "#161616",
    red: "#e0322e",
    redDark: "#5c1411",
    green: "#1fa45a",
    greenDark: "#0d3d23",
    yellow: "#f4c20d",
    yellowDark: "#544205",
    blue: "#1c7fd6",
    blueDark: "#0a2c4a",
    white: "#ffffff",
    gray: "#9a9a9a",
  };

  if (screen === "loading") {
    return (
      <div style={{ minHeight: 400, display: "flex", alignItems: "center", justifyContent: "center", background: colors.bg, color: colors.white }}>
        <p>กำลังโหลด...</p>
      </div>
    );
  }

  if (screen === "welcome") {
    return (
      <div style={{ minHeight: 600, background: colors.bg, color: colors.white, fontFamily: "system-ui, -apple-system, sans-serif", padding: "24px 16px" }}>
        <h1 style={{ fontSize: 32, fontWeight: 900, textAlign: "center", margin: "8px 0 4px" }}>ติดไรวะ</h1>
        <p style={{ textAlign: "center", color: colors.gray, fontSize: 14, marginBottom: 24 }}>รายงานสภาพจราจรวิภาวดี แบบเรียลไทม์</p>

        <label style={{ display: "block", fontSize: 18, fontWeight: 700, marginBottom: 8 }}>เบอร์โทรศัพท์</label>
        <input
          type="tel"
          inputMode="numeric"
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="08XXXXXXXX"
          maxLength={10}
          style={{
            width: "100%",
            fontSize: 24,
            padding: "16px",
            borderRadius: 12,
            border: "2px solid #333",
            background: "#1f1f1f",
            color: colors.white,
            marginBottom: 20,
            boxSizing: "border-box",
          }}
        />

        <label style={{ display: "block", fontSize: 18, fontWeight: 700, marginBottom: 8 }}>ประเภทยานพาหนะ</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
          {VEHICLES.map((v) => (
            <button
              key={v.id}
              onClick={() => setVehicle(v.id)}
              style={{
                fontSize: 20,
                fontWeight: 700,
                padding: "20px",
                borderRadius: 14,
                border: vehicle === v.id ? `3px solid ${colors.yellow}` : "2px solid #333",
                background: vehicle === v.id ? "#3a3206" : "#1f1f1f",
                color: colors.white,
                display: "flex",
                alignItems: "center",
                gap: 12,
                cursor: "pointer",
              }}
            >
              <span style={{ fontSize: 28 }}>{v.icon}</span>
              {v.label}
            </button>
          ))}
        </div>

        <div style={{ background: "#1a1a1a", borderRadius: 12, padding: 16, marginBottom: 16, fontSize: 13, color: colors.gray, lineHeight: 1.6 }}>
          <p style={{ margin: "0 0 8px", color: colors.white, fontWeight: 700, fontSize: 14 }}>การคุ้มครองข้อมูลส่วนบุคคล (PDPA)</p>
          <p style={{ margin: "0 0 8px" }}>
            แอพนี้เก็บข้อมูลเบอร์โทรศัพท์และประเภทยานพาหนะของคุณ เพื่อใช้สำหรับ (1) ป้องกันการรายงานสแปม
            และ (2) ติดต่อกลับเพื่อการตลาดในกรณีที่คุณยินยอมเพิ่มเติมเท่านั้น คุณสามารถขอถอนความยินยอม
            หรือขอลบข้อมูลได้ตลอดเวลาผ่านเมนูตั้งค่า
          </p>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", marginBottom: 10 }}>
            <input type="checkbox" checked={coreConsent} onChange={(e) => setCoreConsent(e.target.checked)} style={{ width: 20, height: 20, marginTop: 2, flexShrink: 0 }} />
            <span style={{ color: colors.white }}>ฉันยินยอมให้เก็บข้อมูลเบอร์โทรและประเภทยานพาหนะ เพื่อใช้งานฟีเจอร์รายงานจราจร (จำเป็น)</span>
          </label>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
            <input type="checkbox" checked={marketingConsent} onChange={(e) => setMarketingConsent(e.target.checked)} style={{ width: 20, height: 20, marginTop: 2, flexShrink: 0 }} />
            <span style={{ color: colors.white }}>ฉันยินยอมให้ติดต่อกลับเพื่อการตลาด (ไม่บังคับ)</span>
          </label>
        </div>

        {formError && (
          <p style={{ color: colors.red, fontWeight: 700, fontSize: 14, marginBottom: 12, textAlign: "center" }}>{formError}</p>
        )}

        <button
          onClick={handleRegister}
          style={{
            width: "100%",
            fontSize: 22,
            fontWeight: 900,
            padding: "18px",
            borderRadius: 14,
            border: "none",
            background: colors.green,
            color: colors.white,
            cursor: "pointer",
          }}
        >
          เริ่มใช้งาน
        </button>
      </div>
    );
  }

  // ---------- MAIN SCREEN ----------
  const levelLabel = { tollway: "🛣️ วิภาวดี (บนโทลล์เวย์)", local: "🚗 วิภาวดี (ทางราบด้านล่าง)" };

  return (
    <div style={{ minHeight: 600, background: colors.bg, color: colors.white, fontFamily: "system-ui, -apple-system, sans-serif", paddingBottom: 40 }}>
      {/* header */}
      <div style={{ padding: "16px 16px 8px", textAlign: "center" }}>
        <h1 onClick={handleTitleTap} style={{ fontSize: 26, fontWeight: 900, margin: 0, cursor: "pointer", userSelect: "none" }}>
          ติดไรวะ
        </h1>
        {!ttsSupported && (
          <p style={{ fontSize: 11, color: colors.gray, margin: "4px 0 0" }}>เสียงพูดไม่พร้อมใช้งานบนอุปกรณ์นี้ — ใช้ป้ายข้อความแทน</p>
        )}
      </div>

      {/* direction toggle */}
      <div style={{ display: "flex", gap: 8, padding: "8px 16px 12px" }}>
        {Object.entries(DIRECTIONS).map(([key, d]) => (
          <button
            key={key}
            onClick={() => setDirection(key)}
            style={{
              flex: 1,
              fontSize: 16,
              fontWeight: 800,
              padding: "16px 8px",
              borderRadius: 12,
              border: direction === key ? `3px solid ${colors.yellow}` : "2px solid #333",
              background: direction === key ? "#3a3206" : "#1a1a1a",
              color: colors.white,
              cursor: "pointer",
            }}
          >
            {d.icon} {d.label}
          </button>
        ))}
      </div>

      {/* level toggle (tollway vs local) — pick one to view, keeps the screen
          focused on a single road level for fast reading */}
      <div style={{ display: "flex", gap: 8, padding: "0 16px 16px" }}>
        {[
          { key: "tollway", label: "🛣️ โทลล์เวย์ (บน)", accent: colors.yellow, accentDark: colors.yellowDark },
          { key: "local", label: "🚗 ทางราบ (ล่าง)", accent: colors.blue, accentDark: colors.blueDark },
        ].map((opt) => (
          <button
            key={opt.key}
            onClick={() => setSelectedLevel(opt.key)}
            style={{
              flex: 1,
              fontSize: 15,
              fontWeight: 800,
              padding: "14px 8px",
              borderRadius: 12,
              border: selectedLevel === opt.key ? `3px solid ${opt.accent}` : "2px solid #333",
              background: selectedLevel === opt.key ? opt.accentDark : "#1a1a1a",
              color: colors.white,
              cursor: "pointer",
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* signboard — shows only the selected level, with status rows
          color-filled (not just colored text) so red/green reads instantly */}
      <div style={{ padding: "0 16px" }}>
        {(() => {
          const level = selectedLevel;
          const red = reports[level].red;
          const green = reports[level].green;
          const hasAny = red || green;
          return (
            <div style={{ borderRadius: 14, padding: 4, marginBottom: 14, background: "#111", border: `2px solid ${hasAny ? colors.red : colors.green}` }}>
              <p style={{ margin: "10px 12px 10px", fontSize: 15, fontWeight: 800, color: colors.gray }}>{levelLabel[level]}</p>

              {!hasAny && (
                <div style={{ background: colors.greenDark, borderRadius: 10, padding: "16px 14px", margin: "0 4px 4px" }}>
                  <p style={{ margin: 0, fontSize: 19, fontWeight: 900, color: colors.white, lineHeight: 1.4 }}>
                    🟢 {DEFAULT_STATUS}
                  </p>
                </div>
              )}
              {red && (
                <div style={{ background: colors.redDark, borderRadius: 10, padding: "16px 14px", margin: "0 4px 4px" }}>
                  <p style={{ margin: 0, fontSize: 19, fontWeight: 900, color: colors.white, lineHeight: 1.4 }}>
                    🔴 ติดที่ {red.position_text}
                  </p>
                  <p style={{ margin: "4px 0 10px", fontSize: 12, color: "#e8b3b1" }}>
                    อัปเดตเมื่อ {Math.max(0, Math.floor((now - red.timestamp) / 60000))} นาทีที่แล้ว
                  </p>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button
                      onClick={() => handleVote(level, "red", true)}
                      style={{ flex: 1, fontSize: 13, fontWeight: 700, padding: "8px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.25)", background: "rgba(0,0,0,0.25)", color: colors.white, cursor: "pointer" }}
                    >
                      👍 แม่นยำ ({red.upvotes || 0})
                    </button>
                    <button
                      onClick={() => handleVote(level, "red", false)}
                      style={{ flex: 1, fontSize: 13, fontWeight: 700, padding: "8px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.25)", background: "rgba(0,0,0,0.25)", color: colors.white, cursor: "pointer" }}
                    >
                      👎 มั่วแล้ว ({red.downvotes || 0})
                    </button>
                  </div>
                </div>
              )}
              {green && (
                <div style={{ background: colors.greenDark, borderRadius: 10, padding: "16px 14px", margin: "0 4px 4px" }}>
                  <p style={{ margin: 0, fontSize: 19, fontWeight: 900, color: colors.white, lineHeight: 1.4 }}>
                    🟢 โล่งที่ {green.position_text}
                  </p>
                  <p style={{ margin: "4px 0 10px", fontSize: 12, color: "#b3e0c2" }}>
                    อัปเดตเมื่อ {Math.max(0, Math.floor((now - green.timestamp) / 60000))} นาทีที่แล้ว
                  </p>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <button
                      onClick={() => handleVote(level, "green", true)}
                      style={{ flex: 1, fontSize: 13, fontWeight: 700, padding: "8px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.25)", background: "rgba(0,0,0,0.25)", color: colors.white, cursor: "pointer" }}
                    >
                      👍 แม่นยำ ({green.upvotes || 0})
                    </button>
                    <button
                      onClick={() => handleVote(level, "green", false)}
                      style={{ flex: 1, fontSize: 13, fontWeight: 700, padding: "8px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.25)", background: "rgba(0,0,0,0.25)", color: colors.white, cursor: "pointer" }}
                    >
                      👎 มั่วแล้ว ({green.downvotes || 0})
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* cooldown banner */}
      {onCooldown && (
        <div style={{ margin: "0 16px 12px", padding: "10px 14px", background: colors.yellowDark, borderRadius: 10, fontSize: 13, fontWeight: 700, textAlign: "center" }}>
          ส่งรายงานล่าสุดไปแล้ว รออีก {Math.ceil(cooldownRemaining / 60000)} นาทีก่อนส่งใหม่
        </div>
      )}

      {/* quick report grid — only shows buttons for the currently selected
          level, so the person reports for the road they're actually on */}
      <div style={{ padding: "8px 16px" }}>
        <p style={{ fontSize: 16, fontWeight: 800, margin: "8px 0" }}>
          รายงานสถานะ {selectedLevel === "tollway" ? "บนโทลล์เวย์" : "ทางราบล่าง"}
        </p>
        <div style={{ display: "flex", gap: 10 }}>
          <BigStatusButton status={STATUS_OPTIONS[0]} disabled={onCooldown} onClick={() => openReportModal(selectedLevel, "red")} colors={colors} />
          <BigStatusButton status={STATUS_OPTIONS[1]} disabled={onCooldown} onClick={() => openReportModal(selectedLevel, "green")} colors={colors} />
        </div>
        <p style={{ fontSize: 12, color: colors.gray, marginTop: 10 }}>
          กดสถานะ แอพจะระบุตำแหน่งให้อัตโนมัติจาก GPS เครื่องคุณ (ไม่ต้องพิมพ์)
        </p>
      </div>

      {/* toast */}
      {toast && (
        <div style={{ position: "sticky", bottom: 12, margin: "16px", padding: "12px 16px", background: "#222", border: "1px solid #444", borderRadius: 10, fontSize: 14, fontWeight: 700, textAlign: "center" }}>
          {toast}
        </div>
      )}

      {/* report confirmation modal: GPS-first, manual landmark fallback */}
      {reportModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}>
          <div style={{ background: "#1a1a1a", borderRadius: 16, padding: 24, width: "100%", maxWidth: 360, border: "2px solid #444" }}>
            <p style={{ fontSize: 18, fontWeight: 800, margin: "0 0 4px" }}>
              {STATUS_OPTIONS.find((s) => s.id === reportModal.statusId)?.color === "red" ? "🔴" : "🟢"}{" "}
              ยืนยันรายงาน {reportModal.level === "tollway" ? "บนโทลล์เวย์" : "ทางราบล่าง"}
            </p>
            <p style={{ fontSize: 13, color: colors.gray, margin: "0 0 16px" }}>
              สถานะ: {STATUS_OPTIONS.find((s) => s.id === reportModal.statusId)?.label}
            </p>

            {locating && (
              <div style={{ background: "#111", borderRadius: 10, padding: 16, marginBottom: 16, textAlign: "center" }}>
                <p style={{ fontSize: 14, color: colors.gray, margin: 0 }}>📍 กำลังระบุตำแหน่งของคุณ...</p>
              </div>
            )}

            {!locating && autoPosition && (
              <div style={{ background: colors.greenDark, borderRadius: 10, padding: 16, marginBottom: 16 }}>
                <p style={{ fontSize: 13, color: colors.gray, margin: "0 0 4px" }}>ตำแหน่งที่ตรวจพบอัตโนมัติ</p>
                <p style={{ fontSize: 17, fontWeight: 800, margin: 0 }}>📍 {autoPosition.text}</p>
              </div>
            )}

            {!locating && !autoPosition && (
              <div style={{ marginBottom: 16 }}>
                {locationError && <p style={{ fontSize: 13, color: colors.yellow, marginBottom: 10 }}>{locationError}</p>}
                <p style={{ fontSize: 13, color: colors.gray, marginBottom: 8 }}>เลือกจุดที่ใกล้ที่สุดด้วยตนเอง</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 220, overflowY: "auto" }}>
                  {LANDMARKS[reportModal.level].map((lm) => (
                    <button
                      key={lm.id}
                      onClick={() => setManualLandmarkId(lm.id)}
                      style={{
                        fontSize: 15,
                        fontWeight: 700,
                        padding: "12px",
                        borderRadius: 10,
                        border: manualLandmarkId === lm.id ? `2px solid ${colors.yellow}` : "1px solid #333",
                        background: manualLandmarkId === lm.id ? "#3a3206" : "#111",
                        color: colors.white,
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                    >
                      📍 {lm.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={submitReport}
                disabled={locating || (!autoPosition && !manualLandmarkId)}
                style={{
                  flex: 1,
                  padding: 14,
                  borderRadius: 10,
                  border: "none",
                  background: colors.green,
                  color: colors.white,
                  fontWeight: 800,
                  fontSize: 15,
                  cursor: locating || (!autoPosition && !manualLandmarkId) ? "not-allowed" : "pointer",
                  opacity: locating || (!autoPosition && !manualLandmarkId) ? 0.5 : 1,
                }}
              >
                ยืนยันส่งรายงาน
              </button>
              <button onClick={closeReportModal} style={{ flex: 1, padding: 14, borderRadius: 10, border: "1px solid #444", background: "transparent", color: colors.white, cursor: "pointer" }}>
                ยกเลิก
              </button>
            </div>
          </div>
        </div>
      )}

      {/* admin modal */}
      {adminOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 20 }}>
          <div style={{ background: "#1a1a1a", borderRadius: 16, padding: 24, width: "100%", maxWidth: 340, border: "2px solid #444" }}>
            <p style={{ fontSize: 18, fontWeight: 800, margin: "0 0 16px" }}>⚠️ เมนูผู้ดูแลระบบ</p>
            {!adminUnlocked ? (
              <>
                <input
                  type="password"
                  value={adminPwInput}
                  onChange={(e) => setAdminPwInput(e.target.value)}
                  placeholder="รหัสผ่าน"
                  style={{ width: "100%", fontSize: 18, padding: 12, borderRadius: 10, border: "2px solid #333", background: "#111", color: colors.white, marginBottom: 12, boxSizing: "border-box" }}
                />
                {adminError && <p style={{ color: colors.red, fontSize: 13, marginBottom: 12 }}>{adminError}</p>}
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={handleAdminSubmit} style={{ flex: 1, padding: 12, borderRadius: 10, border: "none", background: colors.blue, color: colors.white, fontWeight: 700, cursor: "pointer" }}>
                    เข้าสู่ระบบ
                  </button>
                  <button onClick={() => { setAdminOpen(false); setAdminPwInput(""); setAdminError(""); }} style={{ flex: 1, padding: 12, borderRadius: 10, border: "1px solid #444", background: "transparent", color: colors.white, cursor: "pointer" }}>
                    ปิด
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ fontSize: 13, color: colors.gray, marginBottom: 16 }}>ปุ่มนี้จะล้างรายงานจราจรทั้งหมดในระบบ (ทุกทิศทาง)</p>
                <button onClick={handleResetAll} style={{ width: "100%", padding: 14, borderRadius: 10, border: "none", background: colors.red, color: colors.white, fontWeight: 800, fontSize: 16, cursor: "pointer", marginBottom: 16 }}>
                  ⚠️ Reset All to Clear
                </button>

                <div style={{ borderTop: "1px solid #333", paddingTop: 16, marginBottom: 16 }}>
                  <p style={{ fontSize: 13, color: colors.gray, marginBottom: 10 }}>
                    ส่งออกข้อมูลผู้ใช้ทั้งหมด (เบอร์โทร/ประเภทรถ) เป็นไฟล์ .csv เพื่อนำไปเปิดใน Google Sheets ด้วยตนเอง — ไม่มีการ sync อัตโนมัติ
                  </p>
                  <button onClick={handleExportUsersCsv} style={{ width: "100%", padding: 14, borderRadius: 10, border: "none", background: colors.blue, color: colors.white, fontWeight: 800, fontSize: 15, cursor: "pointer" }}>
                    📄 Export Users to CSV
                  </button>
                  {exportStatus && <p style={{ fontSize: 12, color: colors.gray, marginTop: 8 }}>{exportStatus}</p>}
                </div>

                <button onClick={() => { setAdminOpen(false); setAdminUnlocked(false); setAdminPwInput(""); }} style={{ width: "100%", padding: 12, borderRadius: 10, border: "1px solid #444", background: "transparent", color: colors.white, cursor: "pointer" }}>
                  ปิด
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BigStatusButton({ status, disabled, onClick, colors }) {
  const isRed = status.color === "red";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1,
        fontSize: 17,
        fontWeight: 800,
        padding: "22px 10px",
        borderRadius: 12,
        border: "none",
        background: isRed ? colors.red : colors.green,
        color: colors.white,
        textAlign: "center",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {isRed ? "🔴" : "🟢"}
      <br />
      {status.label}
    </button>
  );
}
