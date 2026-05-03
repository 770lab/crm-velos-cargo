// Yoann 2026-05-03 — corrige la pointeuse du 30/04.
// Toutes les livraisons du 30 avaient 8 monteurs affectés à tort
// (équipe NORDINE pré-affectée par défaut + équipe Ricky qui a réellement
// bossé). Yoann confirme : seule l'équipe Ricky a fait le 30.
//
// Action : retirer Imed, Dali, Hamma, Badreddine des monteurIds des
// livraisons du 30/04 (et du 29/04 si jamais ils s'y trouvent).
//
//   node scripts/fix-pointeuse-30avr.mjs           # DRY-RUN
//   node scripts/fix-pointeuse-30avr.mjs --apply   # APPLY
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();
const APPLY = process.argv.includes("--apply");

const NORDINE_IDS = new Set([
  "89GvAri6Wybo8w31uLiB", // Imed
  "EAFPUnXqvVwLfT9isra6", // Dali
  "M32rsiL8WUkOaF5NZCA7", // Hamma
  "MH4yYRMcUldXjHUegeAd", // Badreddine
]);
const NORDINE_NOMS = new Map([
  ["89GvAri6Wybo8w31uLiB", "Imed"],
  ["EAFPUnXqvVwLfT9isra6", "Dali"],
  ["M32rsiL8WUkOaF5NZCA7", "Hamma"],
  ["MH4yYRMcUldXjHUegeAd", "Badreddine"],
]);

const isoOf = (x) => x?.toDate ? x.toDate().toISOString() : (typeof x === "string" ? x : null);
const FieldValue = admin.firestore.FieldValue;

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} retrait NORDINE des monteurs 29/30 avr ===\n`);

const livSnap = await db.collection("livraisons").get();
let nbCorrigees = 0;
for (const d of livSnap.docs) {
  const l = d.data();
  const day = (isoOf(l.datePrevue) || "").slice(0, 10);
  if (day !== "2026-04-29" && day !== "2026-04-30") continue;
  if (l.statut === "annulee") continue;
  const monteurIds = Array.isArray(l.monteurIds) ? l.monteurIds : [];
  const aRetirer = monteurIds.filter((id) => NORDINE_IDS.has(id));
  if (aRetirer.length === 0) continue;
  const after = monteurIds.filter((id) => !NORDINE_IDS.has(id));
  console.log(`  ${day} liv ${d.id} : on retire ${aRetirer.map((id) => NORDINE_NOMS.get(id) || id).join(", ")}`);
  console.log(`    avant : ${monteurIds.length} monteurs · après : ${after.length} monteurs`);
  if (APPLY) {
    await d.ref.update({
      monteurIds: after,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  nbCorrigees++;
}

console.log(`\n${APPLY ? "✓" : "(dry-run)"} ${nbCorrigees} livraisons corrigées`);
process.exit(0);
