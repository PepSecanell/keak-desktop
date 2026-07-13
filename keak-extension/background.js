// Keak Browser Bridge — background service worker
// Maintains a WebSocket connection to the Keak desktop app (ws://localhost:7777).
// Receives browser commands from Keak AI and executes them in the active tab.
// After each page-mutating command, sends a page snapshot back so Keak AI can chain steps.

const WS_PORT = 7777;
let ws = null;
let connecting = false;

function connect() {
  if (connecting || (ws && ws.readyState === WebSocket.OPEN)) return;
  connecting = true;
  try {
    ws = new WebSocket(`ws://localhost:${WS_PORT}`);
    ws.onopen = () => {
      connecting = false;
      ws.send(JSON.stringify({ type: "hello", client: "chrome-extension" }));
    };
    ws.onmessage = async (event) => {
      let cmd;
      try { cmd = JSON.parse(event.data); } catch { return; }
      const result = await executeCommand(cmd);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "result", id: cmd.id, ...result }));
      }
      // After page-mutating actions, send a snapshot so Overlay knows the step completed.
      // Settle delays are tuned per action type: navigate needs more time than a click.
      const settleMs = { navigate: 400, fill_form: 400, type: 250, key: 250, click: 300 };
      const delay = settleMs[cmd.type] ?? 0;
      if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
        const snap = await executeCommand({ type: "get_page_info" });
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "page_snapshot", id: cmd.id, ...snap }));
        }
      }
    };
    ws.onclose = () => { ws = null; connecting = false; };
    ws.onerror = () => { ws?.close(); };
  } catch {
    ws = null;
    connecting = false;
  }
}

// Keep the service worker alive. Chrome MV3 service workers sleep when idle;
// the alarm fires every minute to reconnect if the WS was lost during sleep.
chrome.alarms.create("keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" && (!ws || ws.readyState !== WebSocket.OPEN)) connect();
});

// Connect immediately on extension load / SW wake-up
connect();

// Popup status check — also triggers a reconnect attempt so the dot turns green quickly.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "status") {
    if (!ws || ws.readyState !== WebSocket.OPEN) connect();
    sendResponse({ connected: !!(ws && ws.readyState === WebSocket.OPEN) });
  }
  return true;
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function executeCommand(cmd) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab" };
  try {
    switch (cmd.type) {
      case "click": {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (selector, text) => {
            let el = null;
            if (selector) el = document.querySelector(selector);
            if (!el && text) {
              const lower = text.toLowerCase();
              const pool = [...document.querySelectorAll(
                "button, a, [role='button'], [role='menuitem'], [role='option'], [role='tab'], [role='link'], input[type='submit'], input[type='button'], label, [tabindex]"
              )];
              // 1. Exact or partial visible text
              el = pool.find(e => e.textContent.trim().toLowerCase().includes(lower));
              // 2. aria-label (Google Drive, Gmail use this for icon buttons)
              if (!el) el = pool.find(e => e.getAttribute("aria-label")?.toLowerCase().includes(lower));
              // 3. data-tooltip or title attribute
              if (!el) el = pool.find(e =>
                e.getAttribute("data-tooltip")?.toLowerCase().includes(lower) ||
                e.getAttribute("title")?.toLowerCase().includes(lower)
              );
              // 4. Broader — any visible element whose only text matches
              if (!el) el = [...document.querySelectorAll("*")].find(e =>
                e.children.length === 0 &&
                (e.textContent.trim().toLowerCase() === lower ||
                 e.getAttribute("aria-label")?.toLowerCase() === lower)
              );
            }
            if (!el) return { ok: false, error: `No element found for: "${text}"` };
            el.scrollIntoView({ block: "center" });
            el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
            el.click();
            return { ok: true, tag: el.tagName, label: (el.getAttribute("aria-label") || el.textContent).trim().slice(0, 80) };
          },
          args: [cmd.selector || null, cmd.text || null],
        });
        return res.result.ok
          ? { success: true, detail: `Clicked: ${res.result.label}` }
          : { success: false, error: res.result.error };
      }

      case "type": {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (selector, text, append) => {
            // Find the best editable target. Order: explicit selector -> the focused editable ->
            // a known rich-text compose body (Gmail / Docs / Outlook) -> the first real text field.
            function findTarget() {
              if (selector) { const s = document.querySelector(selector); if (s) return s; }
              const ae = document.activeElement;
              if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return ae;
              // Gmail / rich compose bodies use a contenteditable div with these markers.
              const compose = document.querySelector(
                'div[aria-label="Message Body"], div[aria-label*="Body"], div[g_editable="true"], ' +
                'div[role="textbox"][contenteditable="true"], [contenteditable="true"]'
              );
              if (compose) return compose;
              return document.querySelector(
                "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='checkbox']):not([type='radio']), textarea"
              );
            }
            const el = findTarget();
            if (!el) return { ok: false, error: "No input found" };
            el.scrollIntoView({ block: "center" });
            el.focus();
            try { el.click(); } catch {}
            const isCE = el.isContentEditable;

            // Clear first unless appending.
            if (!append) {
              if (isCE) {
                el.textContent = "";
              } else {
                const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
                  || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
                if (d?.set) d.set.call(el, ""); else el.value = "";
                el.dispatchEvent(new Event("input", { bubbles: true }));
              }
            }

            if (isCE) {
              // execCommand insertText fires the exact input events Gmail/Docs listen for. This is the
              // reliable way to type into a rich compose box (plain textContent += does not register).
              let ok = false;
              try { el.focus(); ok = document.execCommand("insertText", false, text); } catch {}
              if (!ok) {
                el.textContent = (append ? el.textContent : "") + text;
                el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
              }
            } else {
              // Native value setter + input/change so React-controlled fields (Google Calendar's
              // title/date inputs are React) actually pick up the value.
              const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
                || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
              const val = (append ? el.value : "") + text;
              if (d?.set) d.set.call(el, val); else el.value = val;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              const last = text.slice(-1) || "a";
              el.dispatchEvent(new KeyboardEvent("keydown", { key: last, bubbles: true }));
              el.dispatchEvent(new KeyboardEvent("keyup", { key: last, bubbles: true }));
            }
            return { ok: true, tag: el.tagName, editable: isCE };
          },
          args: [cmd.selector || null, cmd.text || "", !!cmd.append],
        });
        return res.result.ok
          ? { success: true, detail: `Typed into ${res.result.tag}${res.result.editable ? " (rich)" : ""}` }
          : { success: false, error: res.result.error };
      }

      case "key": {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (key) => {
            const el = document.activeElement || document.body;
            el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
            el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
          },
          args: [cmd.key || "Enter"],
        });
        return { success: true };
      }

      case "scroll": {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (dir, amount) => {
            window.scrollBy({ top: dir === "up" ? -amount : amount, behavior: "smooth" });
          },
          args: [cmd.direction || "down", cmd.amount || 400],
        });
        return { success: true };
      }

      case "navigate": {
        await chrome.tabs.update(tab.id, { url: cmd.url });
        // Wait for actual page load instead of a fixed delay (max 6s fallback)
        await new Promise(resolve => {
          const done = () => { chrome.tabs.onUpdated.removeListener(listener); resolve(); };
          const timer = setTimeout(done, 6000);
          function listener(tabId, info) {
            if (tabId === tab.id && info.status === "complete") { clearTimeout(timer); done(); }
          }
          chrome.tabs.onUpdated.addListener(listener);
        });
        return { success: true };
      }

      case "get_page_info": {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({
            title: document.title,
            url: window.location.href,
            text: document.body?.innerText?.slice(0, 3000) || "",
            inputs: [...document.querySelectorAll("input, textarea, select")]
              .map(el => ({ tag: el.tagName, type: el.type, name: el.name, placeholder: el.placeholder, id: el.id }))
              .slice(0, 20),
            buttons: [...document.querySelectorAll(
              "button, [role='button'], [role='menuitem'], [role='tab'], input[type='submit'], a[href]"
            )].map(el => {
                const text = el.textContent?.trim();
                const label = el.getAttribute("aria-label");
                const tooltip = el.getAttribute("data-tooltip") || el.getAttribute("title");
                const best = label || text || tooltip || "";
                return best.slice(0, 60);
              })
              .filter(Boolean)
              .filter((v, i, a) => a.indexOf(v) === i) // dedupe
              .slice(0, 30),
          }),
        });
        return { success: true, page: res.result };
      }

      case "fill_form": {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (fields) => {
            let filled = 0;
            for (const { selector, name, placeholder, value } of fields) {
              let el = null;
              if (selector) el = document.querySelector(selector);
              if (!el && name) el = document.querySelector(`[name="${name}"], [id="${name}"]`);
              if (!el && placeholder) el = [...document.querySelectorAll("input, textarea")]
                .find(e => e.placeholder?.toLowerCase().includes(placeholder.toLowerCase()));
              if (el) {
                el.focus();
                const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
                  || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
                if (desc?.set) desc.set.call(el, value);
                else el.value = value;
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                filled++;
              }
            }
            return { ok: true, filled };
          },
          args: [cmd.fields || []],
        });
        return { success: true, detail: `Filled ${res.result.filled} fields` };
      }

      default:
        return { success: false, error: `Unknown command: ${cmd.type}` };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
}
