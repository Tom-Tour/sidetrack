// addon-kit — preuve de travail des identités, calculée hors du fil principal.
// Copié dans chaque extension par sync.mjs : ne pas modifier la copie, modifier le kit.
//
// Une identité n'est acceptée que si elle s'accompagne d'un nombre (nonce) tel que
// scrypt(identité + nonce) commence par assez de bits à zéro. Le trouver demande une
// centaine d'essais (une seule fois) ; le vérifier, un seul. scrypt réclame 4 Mo de
// mémoire par essai : les cartes graphiques n'y gagnent presque rien. Dans Firefox, un
// essai prend ~140 ms (16 Mo par essai demandaient plus de deux minutes au total).
//
// Le même calcul donne le code d'identité (4 caractères affichés à côté du nom) : pour
// imiter le code de quelqu'un, il faut en plus tomber sur les mêmes derniers octets.
//
// Chaque extension a son propre sel (`app`) : les identités ne passent pas d'une
// extension à l'autre. Messages :
//   { t: "mine", app, pubkey, bits }        → { t: "progress", tries }…, { t: "mined", nonce, code }
//   { t: "verify", app, req, pubkey, nonce } → { t: "verified", req, bits, code }

importScripts("scrypt.js");

const N = 4096;
const R = 8;
const enc = new TextEncoder();

function powHash(app, pubkey, nonce) {
  return scrypt.syncScrypt(enc.encode(`${app}-identity:${pubkey}:${nonce}`), enc.encode(`${app}-pow-v2`), N, R, 1, 32);
}

function code(hash) {
  return [hash[30], hash[31]].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function zeroBits(hash) {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

onmessage = ({ data }) => {
  if (data.t === "mine") {
    for (let nonce = 0; ; nonce++) {
      const hash = powHash(data.app, data.pubkey, nonce);
      if (zeroBits(hash) >= data.bits) return postMessage({ t: "mined", nonce, code: code(hash) });
      postMessage({ t: "progress", tries: nonce + 1 });
    }
  }
  if (data.t === "verify") {
    const hash = powHash(data.app, data.pubkey, data.nonce);
    postMessage({ t: "verified", req: data.req, bits: zeroBits(hash), code: code(hash) });
  }
};
