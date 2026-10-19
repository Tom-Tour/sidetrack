// Injecté dans l'onglet du lecteur (GitHub Pages) : relaie les messages
// entre la page du lecteur et le moteur de l'extension.
const port = browser.runtime.connect({ name: "player" });

function toPage(cmd) {
  window.postMessage({ sidetrack: true, ...cmd }, location.origin);
}

port.onMessage.addListener(toPage);

window.addEventListener("message", (e) => {
  // Les messages de la page ont un "type", nos commandes une "action"
  if (e.source !== window || !e.data?.sidetrack || !e.data.type) return;
  port.postMessage(JSON.parse(JSON.stringify(e.data)));
});

// Signe de vie : si l'extension disparaît, ce minuteur meurt avec elle
// et la page du lecteur se ferme d'elle-même.
setInterval(() => toPage({ action: "ping" }), 1000);
