// Bug timezone : 4 livraisons "livree" + 2 annulees datées 2026-04-28T22:00 UTC
// (= 29/04 00h Paris). Reset à 2026-04-29T07:00:00 (8h Paris) pour qu'elles
// soient interprétées comme du 29 avril.
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
const TARGET_TID_PREFIX = "818b8963";
const NEW_DATE = "2026-04-29T07:00:00.000Z"; // 9h Paris UTC+2

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} fix tz tournée ${TARGET_TID_PREFIX} ===\n`);

const livSnap = await db.collection("livraisons").get();
const tofix = [];
for (const d of livSnap.docs) {
  const l = d.data();
  if (typeof l.tourneeId !== "string" || !l.tourneeId.startsWith(TARGET_TID_PREFIX)) continue;
  let date = "?";
  if (typeof l.datePrevue === "string") date = l.datePrevue;
  else if (l.datePrevue?.toDate) date = l.datePrevue.toDate().toISOString();
  if (!date.startsWith("2026-04-28")) continue;
  tofix.push({
    id: d.id,
    ref: d.ref,
    client: l.clientSnapshot?.entreprise || "?",
    statut: l.statut,
    nbVelos: l.nbVelos,
    avant: date,
  });
}

console.log(`${tofix.length} livraisons à corriger :\n`);
for (const t of tofix) {
  console.log(`  ${t.client.padEnd(30)} ${t.statut.padEnd(10)} ${t.nbVelos}v  ${t.avant} → ${NEW_DATE}`);
}

if (!APPLY) {
  console.log("\n(dry-run, --apply pour exécuter)\n");
  process.exit(0);
}
if (tofix.length === 0) {
  console.log("Rien à faire.\n");
  process.exit(0);
}

const batch = db.batch();
for (const t of tofix) {
  batch.update(t.ref, {
    datePrevue: NEW_DATE,
    datePrevueFixedAt: admin.firestore.FieldValue.serverTimestamp(),
    datePrevueFixedReason: "Bug TZ : était 2026-04-28T22:00 UTC = 29/04 Paris ; recalé sur 29/04 matin",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}
await batch.commit();
console.log(`\n✓ ${tofix.length} livraisons re-datées au ${NEW_DATE}\n`);
process.exit(0);
