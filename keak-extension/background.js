// Keak Browser Bridge — background service worker
// Maintains a WebSocket connection to the Keak desktop app (ws://localhost:7777).
// Receives browser commands from Keak AI and executes them in the active tab.

const WS_PORT = 7777;
let ws = null;
let reconnectTimer = null;

function connect() {
  try {
    ws = new WebSocket(`ws://localhost:${WS_PORT}`);

    ws.onopen = () => {
      console.log("[Keak] Connected to Keak desktop");
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      ws.send(JSON.stringify({ type: "hello", client: "chrome-extension" }));
    };

    ws.onmessage = async (event) => {
      let cmd;
      try { cmd = JSON.parse(event.data); } catch { return; }
      const result = await executeCommand(cmd);
      ws.send(JSON.stringify({ type: "result", id: cmd.id, ...result }));
    };

    ws.onclose = () => {
      ws = null;
      if (!reconnectTimer) reconnectTimer = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws?.close();
    };
  } catch {
    if (!reconnectTimer) reconnectTimer = setTimeout(connect, 3000);
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// Execute a browser command sent by Keak AI.
// Each command has a `type` and optional params.
async function executeCommand(cmd) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab" };

  try {
    switch (cmd.type) {
      // Click an element — by CSS selector OR by visible text content
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

      // Type text into the focused or selected element
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
              const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
                || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
              if (nativeInput && nativeInput.set) nativeInput.set.call(el, (append ? el.value : "") + text);
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

      // Press a key (Enter, Tab, Escape, etc.)
      case "key": {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (key) => {
            document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
            document.activeElement?.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
          },
          args: [cmd.key || "Enter"],
        });
        return { success: true };
      }

      // Scroll the page
      case "scroll": {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (dir, amount) => {
            const px = amount || 400;
            window.scrollBy({ top: dir === "up" ? -px : px, behavior: "smooth" });
          },
          args: [cmd.direction || "down", cmd.amount || 400],
        });
        return { success: true };
      }

      // Navigate to a URL
      case "navigate": {
        await chrome.tabs.update(tab.id, { url: cmd.url });
        return { success: true };
      }

      // Read the page — returns title, URL, and visible text (for Keak AI context)
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
            buttons: [...document.querySelectorAll("button, [role='button'], input[type='submit']")]
              .map(el => el.textContent.trim().slice(0, 60))
              .filter(Boolean)
              .slice(0, 15),
          }),
        });
        return { success: true, page: res.result };
      }

      // Fill multiple form fields at once
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

// Start connecting on extension load
connect();

// Keep the service worker alive by responding to any message
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "status") sendResponse({ connected: ws?.readyState === 1 });
  return true;
});
