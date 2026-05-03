// Yoann 2026-05-03 — ROLLBACK fix-pointeuse-30avr.mjs : les 2 équipes
// (NORDINE + Ricky) ont bien travaillé ce jour-là, elles se sont
// rejointes. Règle métier : "quand je fais travailler quelqu un, c est
// pour la journée" → 1 livraison = 1 jour pointé.
// On remet Imed/Dali/Hamma/Badreddine dans monteurIds des livraisons
// du 30/04.
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();
const APPLY = process.argv.includes("--apply");
const FieldValue = admin.firestore.FieldValue;

const NORDINE = [
  "89GvAri6Wybo8w31uLiB", // Imed
  "EAFPUnXqvVwLfT9isra6", // Dali
  "M32rsiL8WUkOaF5NZCA7", // Hamma
  "MH4yYRMcUldXjHUegeAd", // Badreddine
];
const isoOf = (x) => x?.toDate ? x.toDate().toISOString() : (typeof x === "string" ? x : null);

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} restore NORDINE sur livraisons 30/04 ===\n`);

const livSnap = await db.collection("livraisons").get();
let nb = 0;
for (const d of livSnap.docs) {
  const l = d.data();
  const day = (isoOf(l.datePrevue) || "").slice(0, 10);
  if (day !== "2026-04-30") continue;
  if (l.statut === "annulee") continue;
  const cur = Array.isArray(l.monteurIds) ? l.monteurIds : [];
  const missing = NORDINE.filter((id) => !cur.includes(id));
  if (missing.length === 0) continue;
  const after = [...cur, ...missing];
  console.log(`  liv ${d.id} : +${missing.length} NORDINE (${cur.length} → ${after.length} monteurs)`);
  if (APPLY) {
    await d.ref.update({
      monteurIds: after,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  nb++;
}
console.log(`\n${APPLY ? "✓" : "(dry-run)"} ${nb} livraisons restaurées`);
process.exit(0);
