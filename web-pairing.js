"use strict";
/**
 * Web pairing site (for Railway / any host that gives you a public domain).
 *
 *   GET  /            pairing page (enter number -> get 8-letter code)
 *   GET  /healthz     health check (Railway)
 *   GET  /api/status  { linked, running, status, code, ... }
 *   POST /api/pair    { number, password? } -> { code }
 *
 * After WhatsApp confirms the link, the bot starts automatically and sends a
 * SESSION_ID to the linked number's own chat (it is never shown on the web page).
 *
 * Optional env:  WEB_PASSWORD  (page asks for it before it gives a code)
 *                DATA_DIR      (persistent volume, e.g. /data)
 */
const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const pino = require("pino");
const { AUTH } = require("./utils/paths");

const log = pino({ level: "silent" });
const PAGE = path.join(__dirname, "web", "index.html");
const CODE_LIFETIME_MS = 4 * 60 * 1000;

const S = { status: "idle", number: null, code: null, error: null, sock: null, codeAt: 0, expireTimer: null };
let startCore = () => {};
let coreRunning = () => false;

function isLinked() {
  try { return !!JSON.parse(fs.readFileSync(path.join(AUTH, "creds.json"), "utf8")).registered; } catch (_) { return false; }
}
function wipeAuth() {
  try { fs.rmSync(AUTH, { recursive: true, force: true }); fs.mkdirSync(AUTH, { recursive: true }); } catch (_) {}
}
function closeSock() {
  if (S.expireTimer) { clearTimeout(S.expireTimer); S.expireTimer = null; }
  if (S.sock) {
    try { S.sock.ev.removeAllListeners(); } catch (_) {}
    try { S.sock.end(undefined); } catch (_) {}
    S.sock = null;
  }
}

async function requestCode(number) {
  if (coreRunning() || isLinked() || S.status === "linked")
    throw new Error("This bot is already linked and running. To link another number, delete the saved session first.");
  closeSock();
  wipeAuth();
  Object.assign(S, { status: "connecting", number, code: null, error: null, codeAt: 0 });

  const baileys = require("@whiskeysockets/baileys");
  const makeWASocket = baileys.default;
  const { useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, DisconnectReason } = baileys;
  const browser = baileys.Browsers ? baileys.Browsers.ubuntu("Chrome") : ["Ubuntu", "Chrome", "20.0.04"];

  return new Promise((resolve, reject) => {
    let settled = false, codeSent = false, attempts = 0;
    const settle = (err, val) => {
      if (settled) return;
      settled = true; clearTimeout(guard);
      err ? reject(err) : resolve(val);
    };
    const guard = setTimeout(() => {
      if (!settled) { S.status = "idle"; S.error = "Timed out while contacting WhatsApp. Try again."; closeSock(); settle(new Error(S.error)); }
    }, 50000);

    const connect = async () => {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH);
      let version;
      try { version = (await fetchLatestBaileysVersion()).version; } catch (_) {}
      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, log) },
        logger: log, browser, printQRInTerminal: false, syncFullHistory: false, markOnlineOnConnect: false,
      });
      S.sock = sock;
      sock.ev.on("creds.update", saveCreds);

      if (!state.creds.registered && !codeSent) {
        setTimeout(async () => {
          try {
            const raw = await sock.requestPairingCode(number);
            codeSent = true;
            Object.assign(S, { code: raw, status: "code_ready", codeAt: Date.now() });
            // give up on this code after a few minutes (frees the socket)
            S.expireTimer = setTimeout(() => {
              if (S.status === "code_ready") { S.status = "idle"; S.code = null; S.error = "The code expired. Request a new one."; closeSock(); wipeAuth(); }
            }, CODE_LIFETIME_MS);
            settle(null, raw);
          } catch (e) {
            S.status = "idle"; S.error = "Could not create the code: " + e.message;
            closeSock(); settle(new Error(S.error));
          }
        }, 3000);
      }

      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          S.status = "linked"; S.code = null;
          if (S.expireTimer) { clearTimeout(S.expireTimer); S.expireTimer = null; }
          // Give WhatsApp a moment to flush creds, then DM the SESSION_ID to the linked number itself.
          setTimeout(async () => {
            try {
              const me = String((sock.user && sock.user.id) || "");
              const jid = me.split(":")[0].split("@")[0] + "@s.whatsapp.net";
              const creds = fs.readFileSync(path.join(AUTH, "creds.json"));
              const sid = "MARCO:~" + Buffer.from(creds).toString("base64");
              await sock.sendMessage(jid, { text: "✅ *MARCO X WAQAR MD BOT linked successfully!*\n\nYour bot is starting now. Send *.menu* to see the commands.\n\n🔐 *SESSION_ID* (keep it secret - it is a full login to your WhatsApp).\nSave it as the variable `SESSION_ID` in Railway so the bot survives redeploys without a Volume:" });
              await sock.sendMessage(jid, { text: sid });
            } catch (e) { console.error("[WEB-PAIR] could not send SESSION_ID:", e.message); }
            closeSock();
            setTimeout(() => { try { startCore(); } catch (e) { console.error("[WEB-PAIR] startCore:", e.message); } }, 1500);
          }, 4000);
        }
        if (connection === "close") {
          const status = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
          if (S.status === "linked") return;
          if (status === DisconnectReason.loggedOut) { wipeAuth(); S.status = "idle"; S.error = "WhatsApp logged this device out. Request a new code."; return; }
          if ((isLinked() || codeSent) && ++attempts <= 8) return setTimeout(() => connect().catch((e) => console.error("[WEB-PAIR]", e.message)), 1500);
          if (S.status !== "linked") { S.status = "idle"; S.error = "Connection lost. Request a new code."; closeSock(); settle(new Error(S.error)); }
        }
      });
    };
    connect().catch((e) => { S.status = "idle"; S.error = e.message; settle(e); });
  });
}

// ---------------- tiny HTTP server ----------------
const hits = new Map(); // ip -> [timestamps]
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  list.push(now); hits.set(ip, list);
  return list.length > 12 || (list.length > 1 && now - list[list.length - 2] < 8000);
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const send = (res, code, body, type = "application/json; charset=utf-8") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 4096) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error("bad JSON")); } });
    req.on("error", reject);
  });
}

function publicStatus() {
  const left = S.code ? Math.max(0, Math.round((S.codeAt + CODE_LIFETIME_MS - Date.now()) / 1000)) : 0;
  return {
    linked: isLinked() || S.status === "linked",
    running: coreRunning(),
    status: S.status,
    code: S.status === "code_ready" ? S.code : null,
    number: S.status === "code_ready" ? S.number : null,
    secondsLeft: left,
    error: S.error,
    passwordRequired: !!process.env.WEB_PASSWORD,
  };
}

function start(opts = {}) {
  startCore = opts.startCore || startCore;
  coreRunning = opts.coreRunning || coreRunning;
  const port = Number(opts.port || process.env.PORT || 3000);

  const server = http.createServer(async (req, res) => {
    try {
      const url = (req.url || "/").split("?")[0];
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      if (req.method === "GET" && (url === "/healthz" || url === "/health")) return send(res, 200, "ok", "text/plain");
      if (req.method === "GET" && (url === "/" || url === "/index.html")) return send(res, 200, fs.readFileSync(PAGE), "text/html; charset=utf-8");
      if (req.method === "GET" && url === "/api/status") return send(res, 200, publicStatus());
      if (req.method === "POST" && url === "/api/pair") {
        if (limited(ip)) return send(res, 429, { error: "Too many requests. Please wait a few seconds and try again." });
        const body = await readBody(req);
        if (process.env.WEB_PASSWORD && !safeEq(body.password || "", process.env.WEB_PASSWORD))
          return send(res, 401, { error: "Wrong password." });
        const number = String(body.number || "").replace(/\D/g, "");
        if (number.length < 8 || number.length > 15)
          return send(res, 400, { error: "Invalid number. Use the country code, no + or spaces. Example: 923001234567" });
        const code = await requestCode(number);
        return send(res, 200, { code, number, secondsLeft: Math.round(CODE_LIFETIME_MS / 1000) });
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      console.error("[WEB]", e.message);
      return send(res, /already linked/i.test(e.message) ? 409 : 500, { error: e.message });
    }
  });
  server.on("error", (e) => console.error("[WEB] server error:", e.message));
  server.listen(port, "0.0.0.0", () => console.log("🌐 Pairing website is running on port " + port));
  return server;
}

module.exports = { start, requestCode, isLinked, publicStatus };
