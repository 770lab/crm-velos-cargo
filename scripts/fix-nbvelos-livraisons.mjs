/**
 * Recalcule livraison.nbVelos en re-comptant les vélos non-annulés du client.
 *
 * Bug : livraison.nbVelos est un compteur figé écrit à la création de la
 * livraison. Si on ajoute des vélos au client ensuite, nbVelos ne se met pas
 * à jour → la pastille tournée affiche moins de vélos que la réalité.
 * Découvert le 2026-04-28 sur tournée 818b8963 (32 affiché vs 47 réel).
 *
 * Usage :
 *   node scripts/fix-nbvelos-livraisons.mjs              (dry-run)
 *   node scripts/fix-nbvelos-livraisons.mjs --apply
 */
import admin from "firebase-admin";

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
console.log(`Mode : ${APPLY ? "APPLY ✍️ " : "DRY-RUN 👀"}\n`);

const livs = await db.collection("livraisons").get();
console.log(`Livraisons en base : ${livs.size}\n`);

// Pré-charge tous les vélos non annulés et les indexe par clientId.
const allVelos = await db.collection("velos").get();
const countByClient = new Map();
for (const v of allVelos.docs) {
  const d = v.data();
  if (d.annule) continue;
  countByClient.set(d.clientId, (countByClient.get(d.clientId) || 0) + 1);
}

let needFix = 0;
let alreadyOk = 0;
const updates = [];

for (const livDoc of livs.docs) {
  const l = livDoc.data();
  const before = l.nbVelos || 0;
  const after = countByClient.get(l.clientId) || 0;
  if (before === after) {
    alreadyOk++;
    continue;
  }
  needFix++;
  updates.push({ ref: livDoc.ref, entreprise: l.clientSnapshot?.entreprise || "?", before, after });
}

for (const u of updates) {
  console.log(`${u.entreprise.padEnd(30)} ${String(u.before).padStart(3)} → ${u.after}`);
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Déjà OK   : ${alreadyOk}`);
console.log(`À corriger: ${needFix}`);

if (APPLY && needFix) {
  // Batch par 400 (limite 500 ops/batch)
  for (let i = 0; i < updates.length; i += 400) {
    const batch = db.batch();
    for (const u of updates.slice(i, i + 400)) {
      batch.update(u.ref, {
        nbVelos: u.after,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  console.log(`\n✅ ${needFix} livraisons corrigées.`);
} else if (!APPLY) {
  console.log(`\n→ Relance avec --apply pour exécuter.`);
}

process.exit(0);
