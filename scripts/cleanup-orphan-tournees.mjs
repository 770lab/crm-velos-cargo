/**
 * Cleanup : supprime les docs `tournees` sans aucune livraison rattachée.
 *
 * Bug 2026-04-28 : ancienne version de createTournees créait les tournées
 * mais ignorait les `stops` → tournées orphelines (invisibles UI mais
 * persistées en base). Décale la numérotation tourneeNumero.
 *
 * Idempotent. Se base sur la collection livraisons (where tourneeId == X).
 *
 * Usage:
 *   node scripts/cleanup-orphan-tournees.mjs              (dry-run)
 *   node scripts/cleanup-orphan-tournees.mjs --apply
 */
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
console.log(`Mode : ${APPLY ? "APPLY 🗑️ " : "DRY-RUN 👀"}\n`);

// 1) Charge toutes les livraisons et compte par tourneeId
const livSnap = await db.collection("livraisons").get();
const livraisonsParTournee = new Map();
for (const d of livSnap.docs) {
  const tid = String(d.data().tourneeId || "");
  if (!tid) continue;
  livraisonsParTournee.set(tid, (livraisonsParTournee.get(tid) || 0) + 1);
}

// 2) Charge toutes les tournées et identifie les orphelines
const tourneesSnap = await db.collection("tournees").get();
console.log(`Total tournées : ${tourneesSnap.size}`);
console.log(`Total livraisons : ${livSnap.size}\n`);

const orphelines = [];
for (const d of tourneesSnap.docs) {
  const nbLiv = livraisonsParTournee.get(d.id) || 0;
  if (nbLiv === 0) {
    const o = d.data();
    orphelines.push({
      id: d.id,
      datePrevue: o.datePrevue || "(sans date)",
      mode: o.mode || "(sans mode)",
      createdAt: o.createdAt?.toDate?.()?.toISOString() || "(sans createdAt)",
    });
  }
}

console.log(`Tournées orphelines (0 livraison) : ${orphelines.length}\n`);
for (const t of orphelines) {
  console.log(`  ${t.id} · ${t.datePrevue} · ${t.mode} · ${t.createdAt}`);
}

if (orphelines.length === 0) {
  console.log("\n✅ Rien à nettoyer.");
  process.exit(0);
}

if (APPLY) {
  // Batch deletes par lots de 400 (max 500 par batch Firestore)
  const CHUNK = 400;
  let deleted = 0;
  for (let i = 0; i < orphelines.length; i += CHUNK) {
    const chunk = orphelines.slice(i, i + CHUNK);
    const batch = db.batch();
    for (const t of chunk) {
      batch.delete(db.collection("tournees").doc(t.id));
    }
    await batch.commit();
    deleted += chunk.length;
  }
  console.log(`\n🗑️  ${deleted} tournées orphelines supprimées.`);
} else {
  console.log(`\n(dry-run — relance avec --apply pour supprimer)`);
}
