// Recherche élargie : 2 chars de différence + Levenshtein
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const TARGET = process.argv[2] || "BC6AHEK88E";
console.log(`\n=== Recherche élargie "${TARGET}" ===\n`);

// Levenshtein
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
console.log(`Scan ${allSnap.size} vélos en base...\n`);

const matches = [];
for (const d of allSnap.docs) {
  const v = d.data();
  const fn = String(v.fnuci || "").toUpperCase();
  if (!fn) continue;
  const dist = lev(TARGET, fn);
  if (dist <= 2) {
    matches.push({
      id: d.id,
      fnuci: fn,
      clientId: v.clientId,
      annule: v.annule || false,
      dist,
    });
  }
}

matches.sort((a, b) => a.dist - b.dist);
console.log(`${matches.length} vélos à distance ≤ 2 du FNUCI cible\n`);

for (const m of matches.slice(0, 20)) {
  const c = m.clientId ? await db.collection("clients").doc(m.clientId).get() : null;
  console.log(
    `  dist=${m.dist}  ${m.fnuci}  ${m.annule ? "ANNULÉ" : "actif"}  clientId=${m.clientId}  client=${c?.data()?.entreprise || "?"}  veloId=${m.id}`,
  );
}

// Recherche aussi dans `fnuciPrevious`
console.log(`\n=== Recherche dans fnuciPrevious (corrections passées) ===\n`);
const prevAll = allSnap.docs.filter((d) => d.data().fnuciPrevious);
const prevMatches = [];
for (const d of prevAll) {
  const v = d.data();
  const prev = String(v.fnuciPrevious || "").toUpperCase();
  const dist = lev(TARGET, prev);
  if (dist <= 2) {
    prevMatches.push({ id: d.id, prev, current: v.fnuci, clientId: v.clientId, dist });
  }
}
console.log(`${prevMatches.length} matches dans fnuciPrevious\n`);
for (const m of prevMatches) {
  const c = m.clientId ? await db.collection("clients").doc(m.clientId).get() : null;
  console.log(
    `  dist=${m.dist}  ANCIEN=${m.prev} -> ACTUEL=${m.current}  client=${c?.data()?.entreprise || "?"}  veloId=${m.id}`,
  );
}

process.exit(0);
