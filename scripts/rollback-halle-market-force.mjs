// Yoann 2026-05-04 — Rollback du force-charge HALLE MARKET. Yoann préfère
// scanner les 10 FNUCI manquants manuellement plutôt que les laisser
// forcés sans FNUCI. On retire datePreparation + dateChargement sur les
// vélos qui ont chargementForceReason = "fix-force-charge-halle-market…"
//
//   node scripts/rollback-halle-market-force.mjs           # DRY-RUN
//   node scripts/rollback-halle-market-force.mjs --apply   # APPLY
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();
const APPLY = process.argv.includes("--apply");

const cSnap = await db.collection("clients")
  .where("entreprise", "==", "HALLE MARKET").get();
if (cSnap.empty) { console.log("client introuvable"); process.exit(1); }
const cDoc = cSnap.docs[0];

const vSnap = await db.collection("velos").where("clientId", "==", cDoc.id).get();
let nbRollback = 0;
const FieldValue = admin.firestore.FieldValue;
for (const vd of vSnap.docs) {
  const v = vd.data();
  const reason = v.chargementForceReason || v.preparationForceReason || "";
  if (!reason.includes("fix-force-charge-halle-market")) continue;
  console.log(`  ${vd.id.slice(0, 8)}…  fnuci=${v.fnuci || "—"}  → rollback prep+charge`);
  if (APPLY) {
    await db.collection("velos").doc(vd.id).update({
      datePreparation: FieldValue.delete(),
      dateChargement: FieldValue.delete(),
      preparationForceReason: FieldValue.delete(),
      chargementForceReason: FieldValue.delete(),
      rollbackReason: "rollback-halle-market-force 2026-05-04 — Yoann scan FNUCI manuellement",
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  nbRollback++;
}
console.log(`\n${APPLY ? "✓ APPLIQUÉ" : "(DRY-RUN)"} ${nbRollback} vélo(s) rollback`);
process.exit(0);
