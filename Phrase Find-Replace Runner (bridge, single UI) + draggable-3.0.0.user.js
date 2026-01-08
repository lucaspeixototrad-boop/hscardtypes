// ==UserScript==
// @name         Phrase Find/Replace Runner (bridge, single UI) + draggable
// @namespace    phrase.findreplace.runner.bridge
// @version      3.0.0
// @description  Find/replace from the active segment downward in Phrase. Single UI in top window. Worker logic runs in each frame and reports via postMessage. Replaces by select-all + delete + insertText. Navigates with ArrowDown. Stops cleanly at end (no_next_segment).
// @match        https://app.phrase.com/*
// @match        https://*.phrase.com/*
// @match        https://cloud.memsource.com/*
// @match        https://*.memsource.com/*
// @exclude      https://cloud.memsource.com/web/project*
// @exclude      https://cloud.memsource.com/web/job2/list*
// @exclude      https://cloud.memsource.com/web/job2/list*
// @exclude      https://cloud.memsource.com/tms/transMemory/list*
// @exclude      https://cloud.memsource.com/tms/setup/*
// @exclude      https://cloud.memsource.com/web/setup/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const IS_TOP = window.top === window;
  const MSG_MARK = "__pfr_bridge__";
  const FRAME_ID = `${location.origin}${location.pathname}#${Math.random().toString(16).slice(2)}`;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => performance.now();

  /******************************************************************
   * Shared: Active segment detection (per-document)
   ******************************************************************/
  const finders = {
    byCursorId: d => d.getElementById?.("segment-text-editor-input")?.closest?.(".twe_segment") || null,
    byCursorNode: d => d.querySelector?.("#segment-text-editor-input.te_cursor, #segment-text-editor-input .te_cursor")?.closest?.(".twe_segment") || null,
    byCursor: d => d.querySelector?.(".twe_segment .twe_target .te_selection_container .te_cursor")?.closest?.(".twe_segment") || null,
    byFocused(d) {
      const a = d.activeElement;
      if (!a) return null;
      return a.closest?.(".twe_segment") || a.closest?.('[data-testid="segment"]') || null;
    },
    byActiveClass: d => d.querySelector?.('.twe_segment.twe_active, .twe_segment.twe_active_background, [data-testid="segment"][data-selected="true"]') || null
  };

  function getActiveRow(doc) {
    return (
      finders.byCursorId(doc) ||
      finders.byCursorNode(doc) ||
      finders.byCursor(doc) ||
      finders.byFocused(doc) ||
      finders.byActiveClass(doc) ||
      null
    );
  }

  function getReadContainer(row) {
    return (
      row?.querySelector?.(".twe_target .te_text_container") ||
      row?.querySelector?.("[data-testid='target'] .te_text_container") ||
      null
    );
  }

  function readSegmentText(row) {
    const cont = getReadContainer(row);
    return cont ? (cont.innerText ?? cont.textContent ?? "") : "";
  }

  function getRowKey(row) {
    if (!row) return "";
    const sid = row.getAttribute?.("data-segment-id") || row.id || "";
    const r = row.getBoundingClientRect?.();
    const pos = r ? `${Math.round(r.top)}:${Math.round(r.height)}` : "";
    const prefix = readSegmentText(row).slice(0, 24);
    return `${sid}::${pos}::${prefix}`;
  }

  /******************************************************************
   * Shared: Writing + navigation (per-document)
   ******************************************************************/
  function dispatchKey(doc, target, type, opts) {
    try {
      target.dispatchEvent(new doc.defaultView.KeyboardEvent(type, { bubbles:true, cancelable:true, ...opts }));
      return true;
    } catch {
      return false;
    }
  }

  function sendCtrlA(doc, target) {
    dispatchKey(doc, target, "keydown", { key:"a", code:"KeyA", ctrlKey:true });
    dispatchKey(doc, target, "keyup",   { key:"a", code:"KeyA", ctrlKey:true });
  }

  function sendBackspace(doc, target) {
    dispatchKey(doc, target, "keydown", { key:"Backspace", code:"Backspace" });
    dispatchKey(doc, target, "keyup",   { key:"Backspace", code:"Backspace" });
  }

  function sendArrowDown(doc, target) {
    dispatchKey(doc, target, "keydown", { key:"ArrowDown", code:"ArrowDown" });
    dispatchKey(doc, target, "keyup",   { key:"ArrowDown", code:"ArrowDown" });
  }

  function execCmd(doc, name, arg) {
    try { return !!doc.execCommand?.(name, false, arg); } catch { return false; }
  }

  function focusSegment(row) {
    const clickTarget =
      row?.querySelector?.(".twe_target") ||
      row?.querySelector?.(".twe_target .te_selection_container") ||
      row?.querySelector?.(".twe_target .te_text_container") ||
      row;

    if (!clickTarget) return false;
    try { clickTarget.scrollIntoView({ block:"center" }); } catch {}
    try {
      clickTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles:true }));
      clickTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles:true }));
      clickTarget.dispatchEvent(new MouseEvent("click", { bubbles:true }));
      return true;
    } catch {
      return false;
    }
  }

  function findCaptureTarget(doc, row) {
    return (
      row?.querySelector?.("input.twe-main-input, textarea.twe-main-input") ||
      doc.querySelector?.("input.twe-main-input, textarea.twe-main-input") ||
      row?.querySelector?.("#segment-text-editor-input") ||
      doc.getElementById?.("segment-text-editor-input") ||
      null
    );
  }

  function describeEl(el) {
    if (!el) return "null";
    const tag = el.tagName?.toLowerCase?.() || "node";
    const id = el.id ? `#${el.id}` : "";
    const cls = el.className ? `.${String(el.className).trim().split(/\s+/).slice(0,3).join(".")}` : "";
    return `${tag}${id}${cls}`;
  }

  async function selectAllAndClear(doc, cap) {
    try { cap.focus?.(); } catch {}
    await sleep(15);

    sendCtrlA(doc, cap);
    await sleep(20);

    const delOk = execCmd(doc, "delete");
    await sleep(15);

    sendBackspace(doc, cap);
    return { delOk };
  }

  async function writeWholeString(doc, row, text) {
    focusSegment(row);
    await sleep(60);

    const cap = findCaptureTarget(doc, row);
    if (!cap) return { ok:false, reason:"no_capture_target" };

    const editorDesc = describeEl(cap);

    const clr = await selectAllAndClear(doc, cap);
    await sleep(30);

    const cmdOk = execCmd(doc, "insertText", text);
    await sleep(260);

    const verify = readSegmentText(row);
    if (verify === text) {
      return { ok:true, editorDesc, writeMethod:`insertText(cmd=${cmdOk},del=${clr.delOk})` };
    }
    return { ok:false, editorDesc, writeMethod:`failed(cmd=${cmdOk})`, verifyPreview:(verify || "").slice(0,160) };
  }

  async function waitForKeyChangeLocal(doc, prevKey, timeoutMs = 2000) {
    const t0 = now();
    while (now() - t0 < timeoutMs) {
      const row = getActiveRow(doc);
      const k = getRowKey(row);
      if (row && k && k !== prevKey) return true;
      await sleep(90);
    }
    return false;
  }

  async function moveNextOrEnd(doc, row) {
    const prevKey = getRowKey(row);
    const cap = findCaptureTarget(doc, row);
    if (!cap) return { ok:false, reason:"no_capture_target_for_nav" };

    try { cap.focus?.(); } catch {}
    await sleep(30);

    for (let i = 0; i < 4; i++) {
      sendArrowDown(doc, cap);
      const changed = await waitForKeyChangeLocal(doc, prevKey, 2200);
      if (changed) return { ok:true, nav:"ArrowDown" };
      await sleep(120);
    }

    // refocus retry to avoid transient focus glitches
    focusSegment(row);
    await sleep(120);
    try { cap.focus?.(); } catch {}
    await sleep(30);

    for (let i = 0; i < 2; i++) {
      sendArrowDown(doc, cap);
      const changed = await waitForKeyChangeLocal(doc, prevKey, 2200);
      if (changed) return { ok:true, nav:"ArrowDown" };
      await sleep(120);
    }

    return { ok:false, reason:"no_next_segment" };
  }

  async function workerStep(findStr, replStr) {
    const doc = document;
    const row = getActiveRow(doc);
    if (!row) return { handled:false };

    const before = readSegmentText(row);
    const hits = before.includes(findStr) ? (before.split(findStr).length - 1) : 0;

    let writeMethod = "none";
    let editorDesc = "n/a";

    if (hits > 0) {
      const after = before.split(findStr).join(replStr);
      const wr = await writeWholeString(doc, row, after);
      writeMethod = wr.writeMethod || "unknown";
      editorDesc = wr.editorDesc || "unknown";
      if (!wr.ok) {
        return {
          handled:true,
          ok:false,
          reason:"write_not_accepted",
          debug:{ hits, writeMethod, editorDesc, verifyPreview: wr.verifyPreview || "" }
        };
      }
    }

    const nav = await moveNextOrEnd(doc, row);
    if (!nav.ok) {
      return { handled:true, ok:false, reason:nav.reason, debug:{ hits, writeMethod, editorDesc } };
    }

    return { handled:true, ok:true, debug:{ hits, writeMethod, editorDesc, nav:nav.nav } };
  }

  /******************************************************************
   * FRAME WORKER: listen for step requests, reply to top
   ******************************************************************/
  if (!IS_TOP) {
    window.addEventListener("message", async (e) => {
      const d = e?.data;
      if (!d || !d[MSG_MARK]) return;
      if (d.type !== "REQUEST_STEP") return;

      const { reqId, findStr, replStr } = d.payload || {};
      if (!reqId) return;

      let res;
      try {
        res = await workerStep(findStr || "", replStr || "");
      } catch (err) {
        res = { handled:true, ok:false, reason:"worker_exception", debug:{ msg:String(err?.message || err) } };
      }

      try {
        window.parent.postMessage({ [MSG_MARK]:true, type:"STEP_RESULT", frameId:FRAME_ID, payload:{ reqId, res } }, "*");
      } catch {}
    }, true);

    return; // frames do not create UI
  }

  /******************************************************************
   * TOP UI + runner (single window)
   ******************************************************************/
  if (document.getElementById("pfr-ui")) return;

  let running = false;
  let loopId = 0;

  function btnCss() {
    return `
      flex:1;height:30px;border-radius:10px;
      border:1px solid rgba(255,255,255,0.18);
      background:#0b1220;color:#e5e7eb;cursor:pointer;
    `;
  }

  const ui = document.createElement("div");
  ui.id = "pfr-ui";
  ui.style.cssText = `
    position:fixed; left:16px; top:16px; z-index:2147483647;
    width:460px; background:#111827; color:#e5e7eb;
    border:1px solid rgba(255,255,255,0.18);
    border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,0.45);
    font:12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  `;
  ui.innerHTML = `
    <div id="pfr-head" style="padding:10px 12px; cursor:move; user-select:none; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid rgba(255,255,255,0.12);">
      <strong>Phrase Find/Replace</strong>
      <span id="pfr-status" style="opacity:.75;">idle</span>
    </div>
    <div style="padding:10px 12px; display:flex; flex-direction:column; gap:8px;">
      <label style="display:flex; flex-direction:column; gap:4px;">
        <span style="opacity:.85;">Find</span>
        <input id="pfr-find" type="text" style="height:28px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:#0b1220;color:#e5e7eb;padding:0 10px;outline:none;">
      </label>
      <label style="display:flex; flex-direction:column; gap:4px;">
        <span style="opacity:.85;">Replace</span>
        <input id="pfr-repl" type="text" style="height:28px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:#0b1220;color:#e5e7eb;padding:0 10px;outline:none;">
      </label>
      <div style="display:flex; gap:8px; margin-top:4px;">
        <button id="pfr-start" style="${btnCss()}">Start</button>
        <button id="pfr-stop"  style="${btnCss()}">Stop</button>
      </div>
      <div id="pfr-log" style="font-size:11px; opacity:.75; white-space:pre-wrap; max-height:260px; overflow:auto; border-top:1px solid rgba(255,255,255,0.12); padding-top:8px;"></div>
    </div>
  `;
  document.documentElement.appendChild(ui);

  const statusEl = ui.querySelector("#pfr-status");
  const findEl   = ui.querySelector("#pfr-find");
  const replEl   = ui.querySelector("#pfr-repl");
  const startBtn = ui.querySelector("#pfr-start");
  const stopBtn  = ui.querySelector("#pfr-stop");
  const logEl    = ui.querySelector("#pfr-log");
  const headEl   = ui.querySelector("#pfr-head");

  function setStatus(s) { statusEl.textContent = s; }
  function logLine(s) { logEl.textContent = (s + "\n" + (logEl.textContent || "")).slice(0, 14000); }

  // draggable
  (() => {
    let dragging = false, dx = 0, dy = 0;
    headEl.addEventListener("mousedown", (e) => {
      dragging = true;
      const r = ui.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      e.preventDefault();
    }, true);
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      ui.style.left = Math.max(0, e.clientX - dx) + "px";
      ui.style.top  = Math.max(0, e.clientY - dy) + "px";
      ui.style.right = "auto";
      ui.style.bottom = "auto";
    }, true);
    window.addEventListener("mouseup", () => { dragging = false; }, true);
  })();

  /******************************************************************
   * Bridge orchestration (top)
   ******************************************************************/
  const pending = new Map(); // reqId -> { resolve, timer }
  let reqSeq = 0;

  function broadcast(msg) {
    // broadcast to all immediate child frames
    for (let i = 0; i < window.frames.length; i++) {
      try { window.frames[i].postMessage(msg, "*"); } catch {}
    }
  }

  window.addEventListener("message", (e) => {
    const d = e?.data;
    if (!d || !d[MSG_MARK]) return;
    if (d.type !== "STEP_RESULT") return;
    const { reqId, res } = d.payload || {};
    if (!reqId || !pending.has(reqId)) return;
    const entry = pending.get(reqId);
    // We may receive multiple frame answers; resolve with the first that "handled"
    if (res?.handled) {
      clearTimeout(entry.timer);
      pending.delete(reqId);
      entry.resolve(res);
    }
  }, true);

  async function requestStep(findStr, replStr) {
    // First, try to handle in TOP doc itself (some installations mount editor in top)
    const topRes = await workerStep(findStr, replStr);
    if (topRes?.handled) return topRes;

    // Otherwise ask frames. Resolve when any frame says handled=true.
    const reqId = `req_${Date.now()}_${++reqSeq}`;
    const p = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        resolve({ handled:false });
      }, 2200);
      pending.set(reqId, { resolve, timer });
    });

    broadcast({ [MSG_MARK]:true, type:"REQUEST_STEP", payload:{ reqId, findStr, replStr } });

    return await p;
  }

  /******************************************************************
   * Runner loop
   ******************************************************************/
  async function run(myId) {
    setStatus("running");

    while (running && loopId === myId) {
      const findStr = (findEl.value || "").toString();
      const replStr = (replEl.value || "").toString();
      if (!findStr) { setStatus("enter Find"); running = false; return; }

      const res = await requestStep(findStr, replStr);

      if (!res?.handled) {
        setStatus("stopped (no_active_segment)");
        logLine(`STOP: no_active_segment\nDEBUG: {}`);
        running = false;
        return;
      }

      if (!res.ok) {
        if (res.reason === "no_next_segment") {
          setStatus("done (end reached)");
          logLine("DONE: reached last segment.");
        } else {
          setStatus(`stopped (${res.reason})`);
          logLine(`STOP: ${res.reason}\nDEBUG: ${JSON.stringify(res.debug || {}, null, 2)}`);
        }
        running = false;
        return;
      }

      const d = res.debug || {};
      logLine(`STEP ok | hits=${d.hits ?? "?"} | write=${d.writeMethod || "?"} | nav=${d.nav || "?"}`);
      await sleep(60);
    }

    setStatus("idle");
  }

  startBtn.addEventListener("click", () => {
    if (running) return;
    if (!findEl.value) { setStatus("enter Find"); return; }
    running = true;
    loopId++;
    run(loopId);
  });

  stopBtn.addEventListener("click", () => {
    running = false;
    setStatus("stopped");
  });

})();
