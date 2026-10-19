// Injecté dans l'onglet du lecteur (GitHub Pages) : relaie les messages
// entre la page du lecteur et le moteur de l'extension.
const port = browser.runtime.connect({ name: "player" });

port.onMessage.addListener((cmd) => {
  window.postMessage({ sidetrack: true, ...cmd }, location.origin);
});

window.addEventListener("message", (e) => {
  // Les messages de la page ont un "type", nos commandes une "action"
  if (e.source !== window || !e.data?.sidetrack || !e.data.type) return;
  port.postMessage(JSON.parse(JSON.stringify(e.data)));
});
