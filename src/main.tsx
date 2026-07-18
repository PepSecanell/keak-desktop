import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Overlay from "./Overlay";
import Connect from "./Connect";
import Agents from "./Agents";
import Orb from "./Orb";

const view = new URLSearchParams(window.location.search).get("view");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {view === "overlay" ? <Overlay /> : view === "connect" ? <Connect /> : view === "agents" ? <Agents /> : view === "orb" ? <Orb /> : <App />}
  </React.StrictMode>
);
