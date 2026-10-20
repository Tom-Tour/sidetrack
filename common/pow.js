// addon-kit — côté appelant de la preuve de travail (voir pow-worker.js).
// Copié dans chaque extension par sync.mjs : ne pas modifier la copie, modifier le kit.
//
//   const pow = createPow({ app: "pagemates", worker: "common/pow-worker.js" });
//   pow.mine(pubkey, POW.BITS, (tries) => …)  → Promise<{ nonce, code }>
//   pow.check(pubkey, nonce)                   → Promise<{ bits, code }>  (résultats gardés)

const POW = {
  BITS: 7, // ~128 essais : une vingtaine de secondes dans Firefox
  VERSION: 2, // change avec les réglages de pow-worker.js : les anciennes preuves sont recalculées
};

function createPow({ app, worker }) {
  let verifier = null;
  let seq = 0;
  const waiting = new Map();
  const known = new Map(); // pubkey → { nonce, code } déjà vérifiés

  function check(pubkey, nonce) {
    const k = known.get(pubkey);
    if (k?.nonce === nonce) return Promise.resolve({ bits: POW.BITS, code: k.code });
    if (!verifier) {
      verifier = new Worker(worker);
      verifier.onmessage = ({ data }) => {
        waiting.get(data.req)?.(data);
        waiting.delete(data.req);
      };
    }
    const req = ++seq;
    verifier.postMessage({ t: "verify", app, req, pubkey, nonce });
    return new Promise((resolve) => waiting.set(req, resolve)).then(({ bits, code }) => {
      if (bits >= POW.BITS) known.set(pubkey, { nonce, code });
      return { bits, code };
    });
  }

  function mine(pubkey, bits, onProgress) {
    return new Promise((resolve, reject) => {
      const w = new Worker(worker);
      w.onerror = (e) => {
        w.terminate();
        reject(e);
      };
      w.onmessage = ({ data }) => {
        if (data.t === "progress") return onProgress?.(data.tries);
        w.terminate();
        resolve({ nonce: data.nonce, code: data.code });
      };
      w.postMessage({ t: "mine", app, pubkey, bits });
    });
  }

  return { check, mine };
}
