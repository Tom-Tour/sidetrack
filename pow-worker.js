// Preuve de travail des identités (même principe que Pagemates), hors du fil principal.
// Utilisé par l'extension (vérifier) et par la page invité (chercher), d'où le chemin
// de scrypt relatif à ce fichier : vendor/ à côté de lui dans les deux cas.
//
// Une identité n'est acceptée dans un salon public que si elle s'accompagne d'un nombre
// (nonce) tel que scrypt(identité + nonce) commence par assez de bits à zéro. Le trouver
// demande des centaines d'essais (une seule fois par navigateur) ; le vérifier, un seul.
// scrypt réclame 16 Mo de mémoire par essai : les cartes graphiques n'y gagnent presque rien.

importScripts("vendor/scrypt.js");

const N = 16384;
const R = 8;
const enc = new TextEncoder();
const SALT = enc.encode("sidetrack-pow-v1");

function powHash(pubkey, nonce) {
  return scrypt.syncScrypt(enc.encode(`sidetrack-identity:${pubkey}:${nonce}`), SALT, N, R, 1, 32);
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
      if (zeroBits(powHash(data.pubkey, nonce)) >= data.bits) return postMessage({ t: "mined", nonce });
      postMessage({ t: "progress", tries: nonce + 1 });
    }
  }
  if (data.t === "verify") {
    postMessage({ t: "verified", req: data.req, bits: zeroBits(powHash(data.pubkey, data.nonce)) });
  }
};
