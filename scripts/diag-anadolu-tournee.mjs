// Inspecte la livraison ANADOLU + sa tournée pour voir pourquoi la progression
// ne la compte pas.
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const ANADOLU_CID = "cmoa7mb0s02wsb2g26uvc9u5f";

console.log("\n=== Livraisons ANADOLU ===");
const livSnap = await db.collection("livraisons").where("clientId", "==", ANADOLU_CID).get();
for (const d of livSnap.docs) {
  const l = d.data();
  let dt = "?";
  if (typeof l.datePrevue === "string") dt = l.datePrevue.slice(0, 19);
  else if (l.datePrevue?.toDate) dt = l.datePrevue.toDate().toISOString().slice(0, 19);
  console.log(`\n  livId=${d.id}`);
  console.log(`    datePrevue=${dt}`);
  console.log(`    tourneeId=${l.tourneeId || "(null)"}`);
  console.log(`    tourneeNumero=${l.tourneeNumero ?? "(?)"}`);
  console.log(`    statut=${l.statut}`);
  console.log(`    nbVelos=${l.nbVelos}`);
  console.log(`    dejaChargee=${l.dejaChargee ?? false}`);
  console.log(`    validePar=${l.validePar ?? "(?)"}`);
  console.log(`    valideAt=${l.valideAt?.toDate?.()?.toISOString() ?? "(?)"}`);
}

// Cherche la tournée 2 du 30/04
console.log("\n=== Toutes livraisons tournée 2 du 30/04/2026 ===");
const start = new Date("2026-04-30T00:00:00Z");
const end = new Date("2026-04-30T23:59:59Z");
const allLivSnap = await db.collection("livraisons").get();
const tournee2Livraisons = [];
for (const d of allLivSnap.docs) {
  const l = d.data();
  if (l.tourneeNumero !== 2) continue;
  let dt = null;
  if (typeof l.datePrevue === "string") dt = new Date(l.datePrevue);
  else if (l.datePrevue?.toDate) dt = l.datePrevue.toDate();
  if (!dt || dt < start || dt > end) continue;
  tournee2Livraisons.push({ id: d.id, ...l });
}
console.log(`${tournee2Livraisons.length} livraisons trouvées avec tourneeNumero=2 + date=30/04`);
for (const l of tournee2Livraisons) {
  console.log(`\n  ${l.clientSnapshot?.entreprise || l.clientId} (${l.id})`);
  console.log(`    tourneeId=${l.tourneeId || "(null)"}`);
  console.log(`    statut=${l.statut}`);
  console.log(`    nbVelos=${l.nbVelos}`);
}

// Si tournee2Livraisons.length > 0, prendre le tourneeId du 1er et chercher
// toutes les livraisons avec ce tourneeId
const refTid = tournee2Livraisons[0]?.tourneeId;
if (refTid) {
  console.log(`\n=== Toutes livraisons WHERE tourneeId=${refTid} ===`);
  const tidSnap = await db.collection("livraisons").where("tourneeId", "==", refTid).get();
  console.log(`${tidSnap.size} livraisons trouvées`);
  for (const d of tidSnap.docs) {
    const l = d.data();
    console.log(`  ${l.clientSnapshot?.entreprise || l.clientId} : nbVelos=${l.nbVelos}, statut=${l.statut}`);
  }
}

process.exit(0);
