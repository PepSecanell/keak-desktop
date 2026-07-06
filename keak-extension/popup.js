chrome.runtime.sendMessage({ type: "status" }, (res) => {
  const dot = document.getElementById("dot");
  const label = document.getElementById("label");
  const connected = res?.connected;
  dot.className = "dot " + (connected ? "on" : "off");
  label.textContent = connected ? "Connected to Keak" : "Keak desktop not running";
});
