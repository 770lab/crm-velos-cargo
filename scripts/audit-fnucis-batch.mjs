// Audit batch d'une liste de FNUCI attendus (stickers physiques) vs la base.
// Pour chaque FNUCI : match exact ou fuzzy (Levenshtein <= 2). Sort un
// rapport prêt à exécuter pour les corrections nécessaires.
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

// Liste fournie par Yoann 2026-05-01 (stickers DOSTLAR ?)
const EXPECTED = [
  "BC495TJBA2",
  "BC3H8JV8D7",
  "BC77FAKD29",
  "BCE9AEZA4D",
  "BC3C8NKD4Z",
  "BC782JCEEA",
  "BCECFZV2C7",
  "BC278PV8F2",
  "BC7H8BDAZ5",
  "BCD9HHZ89Z",
  "BC432XZC4C",
  "BC3E3TH652",
  "BCZCZTJ5B6",
  "BCB52EJ8E4",
  "BC934BEC64",
  "BCH22CE5HD",
];

function lev(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (!al || !bl) return Math.max(al, bl);
  const dp = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) dp[i][0] = i;
  for (let j = 0; j <= bl; j++) dp[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[al][bl];
}

const allSnap = await db.collection("velos").get();
const allActive = allSnap.docs
  .filter((d) => d.data().annule !== true)
  .map((d) => ({
    id: d.id,
    fnuci: String(d.data().fnuci || "").toUpperCase(),
    clientId: d.data().clientId,
  }));

console.log(`\n=== Audit ${EXPECTED.length} FNUCI vs ${allActive.length} vélos actifs ===\n`);

// Index pour match exact rapide
const byFnuci = new Map();
for (const v of allActive) byFnuci.set(v.fnuci, v);

const clientCache = new Map();
async function clientName(cid) {
  if (!cid) return "?";
  if (clientCache.has(cid)) return clientCache.get(cid);
  const c = await db.collection("clients").doc(cid).get();
  const n = c.exists ? c.data().entreprise || cid : cid;
  clientCache.set(cid, n);
  return n;
}

const exactOk = [];
const fuzzyMatches = [];
const notFound = [];

for (const target of EXPECTED) {
  if (byFnuci.has(target)) {
    exactOk.push({ target, hit: byFnuci.get(target) });
    continue;
  }
  // Fuzzy
  let best = null;
  let bestDist = 99;
  for (const v of allActive) {
    const d = lev(target, v.fnuci);
    if (d < bestDist) {
      bestDist = d;
      best = v;
      if (d === 1) break;
    }
  }
  if (best && bestDist <= 2) {
    fuzzyMatches.push({ target, hit: best, dist: bestDist });
  } else {
    notFound.push({ target, bestDist, best });
  }
}

console.log(`✓ Match exact : ${exactOk.length}/${EXPECTED.length}`);
for (const m of exactOk) {
  const name = await clientName(m.hit.clientId);
  console.log(`   ${m.target} → ${name}`);
}

console.log(`\n⚠ Mismatch fuzzy (à corriger) : ${fuzzyMatches.length}`);
for (const m of fuzzyMatches) {
  const name = await clientName(m.hit.clientId);
  console.log(
    `   ATTENDU=${m.target}  EN BASE=${m.hit.fnuci}  dist=${m.dist}  client=${name}  veloId=${m.hit.id}`,
  );
}

console.log(`\n❌ Introuvables : ${notFound.length}`);
for (const m of notFound) {
  console.log(
    `   ${m.target}  (le plus proche : ${m.best?.fnuci || "—"} dist=${m.bestDist})`,
  );
}

// Génère un script de fix prêt à exécuter
if (fuzzyMatches.length > 0) {
  console.log(`\n=== Lignes pour fix script (FIXES = ...) ===\n`);
  for (const m of fuzzyMatches) {
    console.log(
      `  { veloId: "${m.hit.id}", old: "${m.hit.fnuci}", new: "${m.target}" },`,
    );
  }
}

process.exit(0);
