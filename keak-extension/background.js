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
              el = [...document.querySelectorAll("button, a, [role='button'], input[type='submit'], input[type='button'], label")]
                .find(e => e.textContent.trim().toLowerCase().includes(text.toLowerCase()));
            }
            if (!el) return { ok: false, error: "Element not found" };
            el.scrollIntoView({ block: "center" });
            el.click();
            return { ok: true, tag: el.tagName, text: el.textContent.trim().slice(0, 80) };
          },
          args: [cmd.selector || null, cmd.text || null],
        });
        return res.result.ok
          ? { success: true, detail: `Clicked: ${res.result.text}` }
          : { success: false, error: res.result.error };
      }

      case "type": {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (selector, text, append) => {
            let el = selector ? document.querySelector(selector) : document.activeElement;
            if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && !el.isContentEditable))
              el = document.querySelector("input:not([type='hidden']):not([type='submit']):not([type='button']), textarea");
            if (!el) return { ok: false, error: "No input found" };
            el.focus();
            if (!append) {
              if (el.isContentEditable) el.textContent = "";
              else el.value = "";
            }
            if (el.isContentEditable) {
              el.textContent += text;
              el.dispatchEvent(new Event("input", { bubbles: true }));
            } else {
              const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
                || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
              if (desc?.set) desc.set.call(el, (append ? el.value : "") + text);
              else el.value = (append ? el.value : "") + text;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }
            return { ok: true };
          },
          args: [cmd.selector || null, cmd.text || "", !!cmd.append],
        });
        return res.result.ok ? { success: true } : { success: false, error: res.result.error };
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
            buttons: [...document.querySelectorAll("button, [role='button'], input[type='submit'], a[href]")]
              .map(el => el.textContent.trim().slice(0, 60))
              .filter(Boolean)
              .slice(0, 20),
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
