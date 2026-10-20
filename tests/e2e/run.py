"""Test réel : deux Firefox invisibles et séparés, chacun avec Sidetrack en module temporaire.

Utilise le vrai serveur PeerJS et WebRTC : l'un ouvre un salon privé au nom tiré au hasard,
l'autre le rejoint depuis l'extension. Il faut Firefox 140+ et Selenium
(pip install -r requirements.txt). Lancer : python tests/e2e/run.py

L'extension est copiée dans .out/build avec un fichier de test en plus : un pont qui recopie
l'instantané du moteur dans la page de test (https://example.com/?sttest=…).
"""
import json, os, random, shutil, string, sys, time
from selenium import webdriver
from selenium.webdriver.firefox.options import Options

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(HERE, ".out")
BUILD = os.path.join(OUT, "build")
TAG = "".join(random.choices(string.ascii_lowercase, k=8))
ROOM = f"st-e2e-{TAG}"
PAGE = f"https://example.com/?sttest={TAG}"

shutil.rmtree(BUILD, ignore_errors=True)
shutil.copytree(SRC, BUILD, ignore=shutil.ignore_patterns(".git", ".github", "tests"))
shutil.copy(os.path.join(HERE, "probe-content.js"), BUILD)
man = json.load(open(os.path.join(BUILD, "manifest.json"), encoding="utf-8"))
man["content_scripts"].append({"matches": ["https://example.com/*"], "js": ["probe-content.js"], "run_at": "document_idle"})
json.dump(man, open(os.path.join(BUILD, "manifest.json"), "w", encoding="utf-8"), indent=2)

results = []
def check(name, ok, extra=""):
    results.append((name, ok))
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else "  " + str(extra)), flush=True)

def start(label):
    o = Options()
    o.add_argument("-headless")
    d = webdriver.Firefox(options=o)
    d.set_window_size(1100, 800)
    d.install_addon(BUILD, temporary=True)
    d.get(PAGE)
    d.page_tab = d.current_window_handle
    d.label = label
    return d

def page(d):
    # Le moteur ouvre l'onglet du lecteur : on revient toujours à la page de test
    if d.page_tab in d.window_handles:
        d.switch_to.window(d.page_tab)

def snap(d):
    page(d)
    raw = d.execute_script("return document.documentElement.getAttribute('data-st-snap')")
    return json.loads(raw) if raw else None

REQ = [0]
def ask(d, cmd, *args):
    page(d)
    REQ[0] += 1
    req = REQ[0]
    d.execute_script("window.postMessage({ stProbe: true, cmd: arguments[0], args: arguments[1], req: arguments[2] }, '*')", cmd, list(args), req)
    for _ in range(100):
        raw = d.execute_script("return document.documentElement.getAttribute('data-st-reply-' + arguments[0])", req)
        if raw is not None:
            return json.loads(raw)
        time.sleep(0.05)
    return "timeout"

def wait_for(d, cond, timeout, step=0.5):
    end = time.time() + timeout
    while time.time() < end:
        s = snap(d)
        try:
            if s and cond(s):
                return s
        except (KeyError, TypeError, IndexError):
            pass
        time.sleep(step)
    return None

t0 = time.time()
A = start("A")
B = start("B")
print(f"navigateurs prêts en {time.time() - t0:.1f} s, salon {ROOM}", flush=True)

# 1. Preuve de travail dans le vrai Firefox (scrypt y est bien plus lent que dans Node)
t1 = time.time()
sa = wait_for(A, lambda s: s["me"]["code"] and not s["me"]["mining"], 300)
sb = wait_for(B, lambda s: s["me"]["code"] and not s["me"]["mining"], 300)
check(f"identités prêtes (A {sa and sa['me']['code']}, B {sb and sb['me']['code']}) en {time.time() - t1:.0f} s", bool(sa and sb))

if sa and sb:
    ask(A, "setSetting", "nickname", "Alice")
    ask(B, "setSetting", "nickname", "Bob")

    # 2. A ouvre un salon, B le rejoint depuis l'extension (vrai PeerJS + WebRTC)
    ask(A, "openRoom", {"name": ROOM, "isPublic": False})
    sa = wait_for(A, lambda s: s["room"] and s["room"]["status"] == "open", 60)
    check("salon ouvert sur le vrai serveur PeerJS", bool(sa))
    t2 = time.time()
    ask(B, "joinRoom", ROOM)
    sb = wait_for(B, lambda s: s["guest"] and s["guest"]["status"] == "joined", 120)
    sa = wait_for(A, lambda s: len(s["room"]["players"]) == 1, 30)
    met = bool(sa and sb)
    check(f"B entre dans le salon de A en {time.time() - t2:.0f} s", met, json.dumps((snap(B) or {}).get("guest"))[:300] if not met else "")
    if met:
        codeA, codeB = sa["me"]["code"], sb["me"]["code"]
        check("A voit Bob avec son code", sa["room"]["players"][0]["name"] == "Bob" and sa["room"]["players"][0]["code"] == codeB)
        sb = wait_for(B, lambda s: s["guest"]["hostCode"] == codeA, 20)
        check("B voit le code de l'hôte", bool(sb))

        # 3. Chat dans les deux sens
        time.sleep(1.1)
        ask(B, "guestChat", "bonjour de Bob", False)
        check("message de B reçu par A", bool(wait_for(A, lambda s: any(m.get("text") == "bonjour de Bob" and m.get("code") == codeB for m in s["room"]["chat"]), 20)))
        check("message de A envoyé", ask(A, "hostChat", "bonjour de l'hôte", False) is None)
        check("message de A reçu par B", bool(wait_for(B, lambda s: any(m.get("text") == "bonjour de l'hôte" for m in s["guest"]["chat"]), 20)))

        # 4. Bannir : B est prévenu, retenu « Bob · CODE », ses messages disparaissent
        pubB = sa["room"]["players"][0]["id"]
        ask(A, "ban", pubB)
        sb = wait_for(B, lambda s: s["guest"]["status"] == "ended", 20)
        check("B banni : prévenu", bool(sb and sb["guest"]["endKey"] == "errBanned"))
        sa = wait_for(A, lambda s: s["settings"]["banned"].get(pubB), 10)
        check("liste des bannis : « Bob · CODE »", bool(sa and sa["settings"]["banned"][pubB] == f"Bob · {codeB}"))
        check("ses messages ont disparu chez A", bool(sa and not any(m.get("text") == "bonjour de Bob" for m in sa["room"]["chat"])))
        ask(B, "leaveRoom")
        ask(B, "joinRoom", ROOM)
        sb = wait_for(B, lambda s: s["guest"] and s["guest"]["status"] == "ended", 120)
        check("B refusé en revenant", bool(sb and sb["guest"]["endKey"] == "errBanned"))
        ask(A, "closeRoom")

for d in (A, B):
    d.quit()
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} réussis, {time.time() - t0:.0f} s au total")
sys.exit(1 if failed else 0)
