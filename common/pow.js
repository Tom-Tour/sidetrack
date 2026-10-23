// addon-kit — côté appelant de la preuve de travail (voir pow-worker.js).
// Copié dans chaque extension par sync.mjs : ne pas modifier la copie, modifier le kit.
//
//   const pow = createPow({ app: "pagemates", worker: "common/pow-worker.js" });
//   pow.mine(pubkey, POW.BITS, (tries) => …)  → Promise<{ nonce, code }>
//   pow.check(pubkey, nonce)                   → Promise<{ bits, code }>  (résultats gardés)
//
// Identité complète (clé Nostr + preuve), avec le stockage de l'extension ou de la page :
//
//   const me = createIdentity({ pow, read, write, onChange, onReady });
//   await me.load();   // clé reprise ou créée ; preuve reprise, retrouvée ou calculée
//   me.identity        // { secret (Uint8Array), pubkey, pow (nonce ou null), code }
//   me.mining          // { tries } pendant le calcul, sinon null
//   me.failed          // le calcul a échoué (pas de Worker…) ; me.retry() le relance
//   me.ready()         // Promise : résolue quand la preuve est prête, rejetée si le calcul échoue
//   powPercent(me.mining.tries)  // avancement affiché (bandeau .mining)

const POW = {
  BITS: 7, // ~128 essais : une vingtaine de secondes dans Firefox
  VERSION: 2, // change avec les réglages de pow-worker.js : les anciennes preuves sont recalculées
};

// Avancement estimé du calcul, en % : le nombre d'essais est imprévisible (en moyenne
// 2^bits), la barre avance vite puis ralentit, et n'affiche 100 % qu'une fois fini
function powPercent(tries) {
  return Math.min(99, Math.round(100 * (1 - Math.exp((-2 * (tries || 0)) / 2 ** POW.BITS))));
}

// read() → Promise<{ secret, proof }> : clé (hexadécimal) et preuve gardées, ou rien.
// write({ secret }) / write({ proof }) : à garder (proof = { v, pubkey, nonce, code }).
// onChange() : l'état a changé (à afficher) ; onReady(code) : preuve prête (journal…).
function createIdentity({ pow, read, write, onChange = () => {}, onReady = () => {} }) {
  const me = { identity: { secret: null, pubkey: "", pow: null, code: "" }, mining: null, failed: false };
  const { identity } = me;
  let waiters = [];

  function settle(error) {
    for (const w of waiters) error ? w.reject(error) : w.resolve();
    waiters = [];
  }

  function done(nonce, code) {
    identity.pow = nonce;
    identity.code = code;
    me.mining = null;
    write({ proof: { v: POW.VERSION, pubkey: identity.pubkey, nonce, code } });
    onReady(code);
    settle();
    onChange();
  }

  function mine() {
    me.mining = { tries: 0 };
    me.failed = false;
    onChange();
    let shown = 0;
    pow
      .mine(identity.pubkey, POW.BITS, (tries) => {
        if (!me.mining) return;
        me.mining.tries = tries;
        if (tries - shown >= 5) {
          shown = tries;
          onChange();
        }
      })
      .then(({ nonce, code }) => done(nonce, code))
      .catch((error) => {
        me.mining = null;
        me.failed = true;
        settle(error ?? new Error("pow"));
        onChange();
      });
  }

  me.load = async () => {
    const stored = (await read()) ?? {};
    let secret = typeof stored.secret === "string" && /^[0-9a-f]{64}$/.test(stored.secret) ? stored.secret : null;
    if (!secret) {
      secret = hex(NostrTools.generateSecretKey());
      await write({ secret });
    }
    Object.assign(identity, { secret: unhex(secret), pubkey: NostrTools.getPublicKey(unhex(secret)), pow: null, code: "" });
    const saved = stored.proof;
    if (saved?.pubkey !== identity.pubkey || !Number.isSafeInteger(saved.nonce)) return mine();
    if (saved.v === POW.VERSION && typeof saved.code === "string") {
      identity.pow = saved.nonce;
      identity.code = saved.code;
      settle();
      return;
    }
    // Preuve d'une ancienne version (sans code) : même calcul, une vérification redonne le code
    const { bits, code } = await pow.check(identity.pubkey, saved.nonce);
    if (bits >= POW.BITS) done(saved.nonce, code);
    else mine();
  };

  me.ready = () => {
    if (identity.pow != null) return Promise.resolve();
    if (me.failed) return Promise.reject(new Error("pow"));
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };

  me.retry = () => {
    if (me.failed) mine();
  };

  return me;
}

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
