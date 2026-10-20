// Copie de test seulement : relie le moteur (comme le ferait la barre latérale) au DOM de la
// page de test, que Selenium sait lire. WebDriver ne peut ni ouvrir ni lire moz-extension://.
(() => {
  if (!location.search.includes("sttest=")) return;
  const root = document.documentElement;
  const port = browser.runtime.connect({ name: "sidebar" });
  port.onMessage.addListener((msg) => {
    if (msg.t === "reply") root.setAttribute("data-st-reply-" + msg.req, JSON.stringify(msg.error ?? null));
    else if (msg.t === "snap") root.setAttribute("data-st-snap", JSON.stringify(msg.snap));
  });
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data?.stProbe) port.postMessage({ cmd: e.data.cmd, args: e.data.args, req: e.data.req });
  });
})();
