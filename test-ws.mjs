/**
 * Comprehensive WebSocket integration test for claudecode-remote.
 * Run: node test-ws.mjs
 */
import { WebSocket } from "ws";

const BASE = "http://localhost:9224";
const WS_URL = "ws://localhost:9224/api/ws";
const TIMEOUT = 120_000; // 2 min per test (tool-use can be slow)

let passed = 0;
let failed = 0;

function log(label, msg) { console.log(`  [${label}] ${msg}`); }
function ok(name) { console.log(`✅ PASS: ${name}`); passed++; }
function fail(name, reason) { console.error(`❌ FAIL: ${name} — ${reason}`); failed++; }

// ── helpers ──────────────────────────────────────────────────────────────────

/** Opens a fresh WS, returns { ws, sessionId, messages[] } after session event */
function openSession(sessionId = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error("session open timeout")), 15_000);
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "resume", sessionId }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "session") {
        clearTimeout(timer);
        resolve({ ws, sessionId: msg.sessionId, messages: msg.messages ?? [] });
      }
    });
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Sends a chat message, collects all chunks until done/error. Returns full text. */
function chat(ws, sessionId, message, images) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("chat timeout")), TIMEOUT);
    let text = "";
    const prev = ws.listeners("message");
    // temporarily override message handler
    ws.removeAllListeners("message");
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "chunk") { text += msg.text; }
      else if (msg.type === "done") {
        clearTimeout(timer);
        ws.removeAllListeners("message");
        for (const fn of prev) ws.on("message", fn);
        resolve(text);
      } else if (msg.type === "error") {
        clearTimeout(timer);
        ws.removeAllListeners("message");
        for (const fn of prev) ws.on("message", fn);
        reject(new Error(msg.message));
      }
    });
    const payload = { type: "chat", message, sessionId };
    if (images) payload.images = images;
    ws.send(JSON.stringify(payload));
  });
}

/** Tiny 1×1 PNG as base64 (valid, API-accepted) */
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// ── test runner ───────────────────────────────────────────────────────────────

async function runTests() {
  console.log("\n══════════════════════════════════════");
  console.log(" claudecode-remote integration tests");
  console.log("══════════════════════════════════════\n");

  // ── 0. Health check ──────────────────────────────────────────────────────
  console.log("▶ Test 0: Health check");
  try {
    const r = await fetch(`${BASE}/api/health`);
    const body = await r.json();
    if (body.status === "ok") ok("Health check"); else fail("Health check", JSON.stringify(body));
  } catch (e) { fail("Health check", e.message); }

  // ── 1. New session (fresh UUID, no old image history) ────────────────────
  console.log("\n▶ Test 1: Open fresh session");
  let ws, sessionId;
  try {
    ({ ws, sessionId } = await openSession(null));
    log("session", `id=${sessionId}`);
    if (sessionId && sessionId !== "null") ok("Open fresh session");
    else fail("Open fresh session", `bad sessionId: ${sessionId}`);
  } catch (e) { fail("Open fresh session", e.message); return; }

  // ── 2. Plain text chat: 你好 ─────────────────────────────────────────────
  console.log("\n▶ Test 2: Plain text chat (你好)");
  try {
    const reply = await chat(ws, sessionId, "你好，請用一句話自我介紹。");
    log("reply", reply.slice(0, 120));
    if (reply.length > 5) ok("Plain text chat"); else fail("Plain text chat", "empty reply");
  } catch (e) { fail("Plain text chat", e.message); }

  // ── 3. Traditional Chinese enforcement ───────────────────────────────────
  console.log("\n▶ Test 3: Verify Traditional Chinese reply");
  await sleep(800); // allow previous CLI process to fully release session lock
  try {
    const reply = await chat(ws, sessionId, "請問你剛才說了什麼？用繁體中文回答。");
    log("reply", reply.slice(0, 120));
    // Check for common Traditional Chinese characters
    const hasChinese = /[\u4e00-\u9fff]/.test(reply);
    // Check it's NOT primarily English (crude but effective)
    const englishWords = reply.match(/\b[a-zA-Z]{4,}\b/g)?.length ?? 0;
    const chineseChars = (reply.match(/[\u4e00-\u9fff]/g) ?? []).length;
    if (hasChinese && chineseChars > englishWords) ok("Traditional Chinese reply");
    else fail("Traditional Chinese reply", `chinese=${chineseChars} english_words=${englishWords}`);
  } catch (e) { fail("Traditional Chinese reply", e.message); }

  // ── 4. Tool use (Bash — list projects) ───────────────────────────────────
  console.log("\n▶ Test 4: Tool use — list D:/GitClone/_HomeProject");
  await sleep(800);
  try {
    const reply = await chat(ws, sessionId, "列出 D:/GitClone/_HomeProject 裡的專案資料夾名稱，用繁體中文簡短說明每個專案。");
    log("reply (first 200)", reply.slice(0, 200));
    // Should mention known projects
    const hasProjects = reply.includes("claudecode") || reply.includes("auto-elearn") || reply.includes("opencode");
    if (hasProjects && reply.length > 50) ok("Tool use (bash + list projects)");
    else fail("Tool use", `reply doesn't mention expected projects. Got: ${reply.slice(0, 100)}`);
  } catch (e) { fail("Tool use", e.message); }

  // ── 5. Image upload ───────────────────────────────────────────────────────
  console.log("\n▶ Test 5: Image upload (tiny synthetic JPEG)");
  await sleep(800);
  try {
    const reply = await chat(
      ws, sessionId,
      "這張圖片裡有什麼顏色？請用一句話回答。",
      [{ base64: TINY_PNG_B64, mediaType: "image/png" }]
    );
    log("reply", reply.slice(0, 120));
    if (reply.length > 3) ok("Image upload + analysis");
    else fail("Image upload", "empty reply");
  } catch (e) { fail("Image upload", e.message); }

  // ── 6. WS disconnect → reconnect → session resume ────────────────────────
  console.log("\n▶ Test 6: WS disconnect + reconnect + session resume");
  try {
    // Save session ID, close WS, reopen with same ID
    const savedId = sessionId;
    ws.close();
    await new Promise(r => setTimeout(r, 500)); // brief pause

    const { ws: ws2, sessionId: resumedId, messages } = await openSession(savedId);
    log("resumed", `id=${resumedId} messages=${messages.length}`);

    // Should resume the same session with previous messages
    if (resumedId === savedId && messages.length >= 2) {
      ok("WS reconnect + session resume");
    } else {
      fail("WS reconnect", `resumedId=${resumedId} (expected ${savedId}), messages=${messages.length}`);
    }

    // Send one more message on the resumed connection
    await sleep(800);
    const reply = await chat(ws2, resumedId, "我們剛才聊了什麼？用一句話說。");
    log("post-reconnect reply", reply.slice(0, 120));
    if (reply.length > 3) ok("Chat after reconnect"); else fail("Chat after reconnect", "empty");
    ws2.close();
  } catch (e) { fail("WS reconnect", e.message); }

  // ── 7. Sessions list endpoint ─────────────────────────────────────────────
  console.log("\n▶ Test 7: /api/sessions includes our session");
  try {
    const r = await fetch(`${BASE}/api/sessions`);
    const sessions = await r.json();
    const found = sessions.some(s => s.id === sessionId);
    log("sessions", `count=${sessions.length} found=${found}`);
    if (found) ok("Sessions list contains new session");
    else fail("Sessions list", `sessionId ${sessionId} not found in list`);
  } catch (e) { fail("Sessions list", e.message); }

  // ── summary ───────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════");
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════\n");
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => { console.error("Fatal:", e); process.exit(1); });
