// addon-kit — petits comportements d'interface communs (barre latérale, pages).
// Copié dans chaque extension par sync.mjs : ne pas modifier la copie, modifier le kit.

// Confirmation légère, pour une action sur ses propres données (supprimer une playlist,
// effacer ses dessins) : le bouton devient « Sûr ? » et un second clic dans les 3 s
// confirme. L'état est gardé ici, pas dans le bouton : une interface redessinée entre les
// deux clics ne perd pas le premier. Pour une action qui touche quelqu'un d'autre ou qui
// est définitive (bloquer, bannir), utiliser une fiche de confirmation (GUIDE.md).
//
//   const sure = createSure(render);
//   button.textContent = sure.armed("clear") ? t("sure") : t("clearInk");
//   button.classList.toggle("danger", sure.armed("clear"));
//   button.onclick = () => sure.click("clear", () => act("clearInk"));
function createSure(rerender) {
  let armed = null; // { key, timer }
  return {
    armed: (key) => armed?.key === key,
    click(key, onConfirm) {
      clearTimeout(armed?.timer);
      if (armed?.key === key) {
        armed = null;
        rerender();
        return onConfirm();
      }
      armed = {
        key,
        timer: setTimeout(() => {
          armed = null;
          rerender();
        }, 3000),
      };
      rerender();
    },
  };
}

// Petit « bip » à l'arrivée d'un message (réglage « Son à chaque nouveau message »), sans
// fichier audio
let beepAudio = null;
function beep() {
  try {
    beepAudio ??= new AudioContext();
    const osc = beepAudio.createOscillator();
    const gain = beepAudio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, beepAudio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, beepAudio.currentTime + 0.15);
    osc.connect(gain).connect(beepAudio.destination);
    osc.start();
    osc.stop(beepAudio.currentTime + 0.15);
  } catch {
    // pas de son possible : tant pis
  }
}
