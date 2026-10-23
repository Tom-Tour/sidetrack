// addon-kit — petits comportements d'interface communs (barre latérale, pages).
// Copié dans chaque extension par sync.mjs : ne pas modifier la copie, modifier le kit.

// Élément : el("span", { className: "muted", textContent: "…" }, enfant, "texte", …)
function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function button(label, onClick, className = "") {
  const b = el("button", { textContent: label, className });
  b.addEventListener("click", onClick);
  return b;
}

// Pastille de couleur d'une personne
function swatch(color) {
  const s = el("span", { className: "swatch" });
  if (color) s.style.background = color;
  return s;
}

// Code de 4 caractères lié à l'identité (« … » tant qu'il n'est pas connu) : deux personnes
// au même pseudo n'ont pas le même
function codeTag(code) {
  return el("span", { className: "code", textContent: code || "…", title: t("codeHelp") });
}

// « Nom · CODE » : le code distingue deux personnes qui ont le même nom
const nameWithCode = (name, code) => (code ? `${name} · ${code}` : name);

// Pastille d'une personne (GUIDE.md) : couleur, nom, code, score éventuel, puis de petites
// mentions (« · en sourdine »…). Cliquable (fiche) si onClick ; .me pour soi-même.
//   chip(p, { me, selected, score, tags: ["en sourdine"], onClick, title })
function chip(p, { me = false, selected = false, score = null, tags = [], onClick = null, title = "" } = {}) {
  const c = el(onClick ? "button" : "span", { className: "chip" + (me ? " me" : "") + (selected ? " selected" : "") });
  if (title) c.title = title;
  c.append(swatch(p.color), el("span", { textContent: p.name }), codeTag(p.code));
  if (score != null) c.append(el("b", { textContent: String(score) }));
  for (const tag of tags) c.append(el("span", { className: "tag muted", textContent: "· " + tag }));
  if (onClick) c.addEventListener("click", onClick);
  return c;
}

// Fiche d'une personne (GUIDE.md) : en-tête (couleur, nom, code, ✕), puis ses actions, ou la
// confirmation d'une action qui touche quelqu'un d'autre, avec ses conséquences écrites.
// kind : "block" | "kick" | "ban" → textes `${kind}ConfirmTitle`, `${kind}ConfirmHelp`,
// `${kind}Confirm` (help remplace le texte des conséquences).
//   box.replaceChildren(...personCard(p, { onClose, actions: [boutons] }))
//   box.replaceChildren(...personCard(p, { onClose, confirm: { kind, help, onYes, onNo } }))
function personCard(p, { onClose, actions = [], confirm = null }) {
  const head = el(
    "div",
    { className: "head" },
    swatch(p.color),
    el("strong", { textContent: p.name }),
    codeTag(p.code),
    el("span", { className: "grow" }),
    Object.assign(button("✕", onClose, "small"), { title: t("close") })
  );
  if (!confirm) return [head, el("div", { className: "actions" }, ...actions)];
  const { kind, help, onYes, onNo } = confirm;
  return [
    head,
    el("p", { className: "warn", textContent: t(`${kind}ConfirmTitle`, p.name) }),
    el("p", { className: "muted", textContent: help ?? t(`${kind}ConfirmHelp`) }),
    el("div", { className: "actions" }, button(t(`${kind}Confirm`, p.name), onYes, "danger"), button(t("cancel"), onNo)),
  ];
}

// Bouton qui ouvre la confirmation (⛔ pour bloquer et bannir, GUIDE.md)
function askButton(kind, onClick) {
  const danger = kind === "block" || kind === "ban";
  return button((danger ? "⛔ " : "") + t(`${kind}Ask`), onClick, danger ? "subtle-danger" : "");
}

// Liste des personnes bloquées ou bannies (réglages) : « Nom · CODE », identité en infobulle,
// bouton pour lever la mesure. entries : [[id, « Nom · CODE »], …]
//   list.replaceChildren(...peopleList(entries, { empty: t("noBlocked"), action: t("unblock"), onAction: (id) => … }))
function peopleList(entries, { empty, action, onAction }) {
  if (!entries.length) return [el("li", { className: "muted", textContent: empty })];
  return entries.map(([id, label]) =>
    el(
      "li",
      {},
      // Anciennes entrées (nom seul) : le début de l'identité les distingue
      el("span", { textContent: label.includes("·") ? label : `${label} · ${id.slice(0, 8)}`, title: id }),
      button(action, () => onAction(id), "small")
    )
  );
}

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
