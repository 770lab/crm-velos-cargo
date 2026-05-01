// Recompute des stats clients (totalVelos, prepares, charges, livres)
// pour TOUS les clients où ces compteurs sont désynchronisés vs la
// collection velos. Le trigger Cloud Function onVeloWriteSyncClientStats
// n'a pas tourné après le fix-tournees-30-04 (cause inconnue, à creuser
// séparément). Patch idempotent : on ne touche que les champs trigger.
//
//   node scripts/fix-recompute-client-stats.mjs            # DRY-RUN
//   node scripts/fix-recompute-client-stats.mjs --apply    # exécute
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} recompute client stats ===\n`);

// 1. Récupère tous les vélos non-annulés et compte par client
const vSnap = await db.collection("velos").get();
const real = new Map();
for (const d of vSnap.docs) {
  const v = d.data();
  if (v.annule === true) continue;
  const cid = v.clientId;
  if (!cid) continue;
  if (!real.has(cid)) real.set(cid, { totalVelos: 0, prepares: 0, charges: 0, livres: 0 });
  const r = real.get(cid);
  r.totalVelos++;
  if (v.datePreparation) r.prepares++;
  if (v.dateChargement) r.charges++;
  if (v.dateLivraisonScan) r.livres++;
}

// 2. Pour chaque client, compare aux stats actuelles et liste les diffs
const cSnap = await db.collection("clients").get();
const diffs = [];
for (const d of cSnap.docs) {
  const c = d.data();
  const cur = c.stats || {};
  const want = real.get(d.id) || { totalVelos: 0, prepares: 0, charges: 0, livres: 0 };
  const updates = {};
  for (const k of ["totalVelos", "prepares", "charges", "livres"]) {
    if ((cur[k] ?? 0) !== want[k]) updates[`stats.${k}`] = want[k];
  }
  if (Object.keys(updates).length > 0) {
    diffs.push({ id: d.id, name: c.entreprise || d.id, cur, want, updates, ref: d.ref });
  }
}

console.log(`${diffs.length} clients à corriger sur ${cSnap.size}\n`);
for (const d of diffs) {
  const c = d.cur;
  const w = d.want;
  console.log(
    `  ${d.name.padEnd(35)} cur=(${c.totalVelos ?? 0}/${c.prepares ?? 0}/${c.charges ?? 0}/${c.livres ?? 0}) → want=(${w.totalVelos}/${w.prepares}/${w.charges}/${w.livres})`,
  );
}

if (!APPLY) {
  console.log("\n(dry-run, relance avec --apply pour exécuter)\n");
  process.exit(0);
}

console.log("\n>>> APPLY EN COURS...\n");
const batchSize = 400;
let written = 0;
for (let i = 0; i < diffs.length; i += batchSize) {
  const slice = diffs.slice(i, i + batchSize);
  const batch = db.batch();
  for (const d of slice) {
    batch.update(d.ref, {
      ...d.updates,
      "stats.recomputedAt": admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  written += slice.length;
  console.log(`✓ stats clients recompute : ${written}/${diffs.length}`);
}
console.log(`\n✓ Terminé. ${written} clients recomputés.\n`);
process.exit(0);
