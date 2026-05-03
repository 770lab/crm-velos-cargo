// Yoann 2026-05-03 — corrige le double doc Ricky.
// Convention rules : equipe/{uid} == auth.uid. Le bon doc doit donc être
// celui dont l id = auth.uid de Ricky (YQfL...). On fusionne le contenu
// de l autre doc (l1aU...) dedans, on met actif=true, on remappe les
// monteurs qui pointaient sur l ancien chefId, puis on archive l ancien.
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();
const APPLY = process.argv.includes("--apply");
const FieldValue = admin.firestore.FieldValue;

const AUTH_DOC = "YQfLSxNqOLQ2AaHYhxITllWYxzl1"; // doc id = auth uid
const LEGACY_DOC = "l1aUgLDnrJndrIPAO7K2"; // doc canonique mais mauvais id

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} fusion Ricky ===\n`);

// 1. Charge les 2 docs
const [authSnap, legacySnap] = await Promise.all([
  db.collection("equipe").doc(AUTH_DOC).get(),
  db.collection("equipe").doc(LEGACY_DOC).get(),
]);
if (!authSnap.exists) {
  console.log("⚠ Doc auth introuvable");
  process.exit(1);
}
if (!legacySnap.exists) {
  console.log("⚠ Doc legacy introuvable");
  process.exit(1);
}
const auth = authSnap.data();
const legacy = legacySnap.data();
console.log("Doc auth (id=", AUTH_DOC, ") actif=", auth.actif, "role=", auth.role);
console.log("Doc legacy (id=", LEGACY_DOC, ") actif=", legacy.actif, "role=", legacy.role);

// 2. Compte combien de monteurs ont chefId pointant sur l ancien id
const monteursRefs = await db.collection("equipe").where("chefId", "==", LEGACY_DOC).get();
console.log(`\n${monteursRefs.size} monteurs pointent sur chefId=${LEGACY_DOC} :`);
for (const d of monteursRefs.docs) {
  console.log(`  - ${d.data().nom} (${d.id})`);
}

// 3. Plan d action
console.log("\nPlan :");
console.log(`  a) update ${AUTH_DOC} : nom=Ricky, role=chef, actif=true, aussiMonteur=true,
        legacyMergedFrom=${LEGACY_DOC}, authMismatchAt=null`);
console.log(`  b) update ${monteursRefs.size} monteurs : chefId ${LEGACY_DOC} → ${AUTH_DOC}`);
console.log(`  c) archive doc legacy : actif=false, archivedAt=now,
        archivedReason="merged into ${AUTH_DOC}"`);

if (!APPLY) {
  console.log("\n(dry-run) — relance avec --apply pour exécuter");
  process.exit(0);
}

// 4. Apply
await authSnap.ref.update({
  nom: "Ricky",
  role: "chef",
  actif: true,
  aussiMonteur: true,
  estChefMonteur: true,
  chefId: null, // chef = sommet
  authMismatchAt: FieldValue.delete(),
  legacyMergedFrom: LEGACY_DOC,
  updatedAt: FieldValue.serverTimestamp(),
});
console.log(`✓ doc ${AUTH_DOC} mis à jour`);

const batch = db.batch();
let nbRemap = 0;
for (const d of monteursRefs.docs) {
  if (d.id === AUTH_DOC) continue; // Ricky lui-même = chef, pas son propre chefId
  batch.update(d.ref, { chefId: AUTH_DOC, updatedAt: FieldValue.serverTimestamp() });
  nbRemap++;
}
if (nbRemap > 0) {
  await batch.commit();
  console.log(`✓ ${nbRemap} monteurs remappés sur le nouveau chefId`);
}

await legacySnap.ref.update({
  actif: false,
  archivedAt: FieldValue.serverTimestamp(),
  archivedReason: `merged into ${AUTH_DOC}`,
  authUid: null,
  updatedAt: FieldValue.serverTimestamp(),
});
console.log(`✓ doc legacy ${LEGACY_DOC} archivé`);

console.log("\n✓ Ricky doit maintenant pouvoir se connecter avec son code PIN.");
process.exit(0);
