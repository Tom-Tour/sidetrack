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

// Extension désinstallée, désactivée ou rechargée : la page du lecteur se ferme
port.onDisconnect.addListener(() => toPage({ action: "orphan" }));

// Signe de vie, en secours si la déconnexion n'a pas pu être signalée :
// ce minuteur meurt avec l'extension.
setInterval(() => toPage({ action: "ping" }), 1000);
