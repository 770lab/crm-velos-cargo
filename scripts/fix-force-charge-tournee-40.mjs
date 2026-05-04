// Yoann 2026-05-04 — Tournée 40 : camion parti malgré bug du compteur de
// chargement. Force dateChargement sur les vélos préparés non encore
// chargés de tous les clients de cette tournée.
//
//   node scripts/fix-force-charge-tournee-40.mjs           # DRY-RUN
//   node scripts/fix-force-charge-tournee-40.mjs --apply   # APPLY
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();
const APPLY = process.argv.includes("--apply");

// Trouve la tournée 40 par tourneeNumero (pas par tourneeId aléatoire)
const livSnap = await db.collection("livraisons")
  .where("tourneeNumero", "==", 40).get();
if (livSnap.empty) {
  console.log("Tournée 40 introuvable");
  process.exit(1);
}
const tourneeId = livSnap.docs[0].data().tourneeId;
console.log(`\nTournée 40 (tourneeId=${tourneeId})`);
console.log(`${livSnap.size} livraison(s) :`);

const clientIds = new Set();
for (const ld of livSnap.docs) {
  const l = ld.data();
  if (l.statut === "annulee") {
    console.log(`  ${ld.id.slice(0, 8)}…  ANNULEE skip`);
    continue;
  }
  console.log(`  ${ld.id.slice(0, 8)}…  client=${(l.clientId || "").slice(0, 8)}  nbVelos=${l.nbVelos}  counts=${JSON.stringify(l.counts || {})}`);
  if (l.clientId) clientIds.add(l.clientId);
}

// Récupère tous les vélos de ces clients
let nbCharged = 0;
let nbAlreadyCharged = 0;
let nbNoFnuci = 0;
const now = admin.firestore.FieldValue.serverTimestamp();
const nowIso = new Date().toISOString();

for (const cid of clientIds) {
  const vSnap = await db.collection("velos").where("clientId", "==", cid).get();
  for (const vd of vSnap.docs) {
    const v = vd.data();
    if (v.annule) continue;
    if (!v.fnuci) { nbNoFnuci++; continue; }
    if (v.dateChargement) { nbAlreadyCharged++; continue; }
    if (!v.datePreparation) {
      // pas préparé → on force aussi la prep + chargement (camion parti)
      console.log(`  velo ${vd.id.slice(0, 8)}… fnuci=${v.fnuci} : force prep + charge`);
    } else {
      console.log(`  velo ${vd.id.slice(0, 8)}… fnuci=${v.fnuci} : force charge`);
    }
    if (APPLY) {
      const updates = {
        dateChargement: nowIso,
        chargementForceReason: "fix-force-charge-tournee-40 — camion parti malgre bug compteur",
        updatedAt: now,
      };
      if (!v.datePreparation) {
        updates.datePreparation = nowIso;
        updates.preparationForceReason = "fix-force-charge-tournee-40 — camion parti malgre bug";
      }
      await db.collection("velos").doc(vd.id).update(updates);
    }
    nbCharged++;
  }
}

console.log(`\n${APPLY ? "✓ APPLIQUÉ" : "(DRY-RUN)"}`);
console.log(`  ${nbCharged} vélo(s) marqué(s) chargé(s)`);
console.log(`  ${nbAlreadyCharged} déjà chargés`);
console.log(`  ${nbNoFnuci} sans FNUCI (skip — vélos cibles non scannés)`);
process.exit(0);
