/**
 * Migration : attribue un `tourneeNumero` stable à chaque livraison Firestore.
 * Numérotation globale, ordre chronologique de la 1re datePrevue de chaque
 * tournée. Toutes les livraisons d'une même tournée partagent le même numero.
 *
 * Une fois posé, le numero ne bouge plus même si on annule une tournée
 * antérieure (vs ancien comportement où le numero était recalculé à chaque
 * render).
 *
 * Usage:
 *   node scripts/assign-tournee-numbers.mjs              (dry-run)
 *   node scripts/assign-tournee-numbers.mjs --apply
 */
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
console.log(`Mode : ${APPLY ? "APPLY ✍️ " : "DRY-RUN 👀"}\n`);

const livs = await db.collection("livraisons").get();
console.log(`Livraisons total : ${livs.size}`);

// Group par tourneeId, garde la 1re datePrevue de chaque tournée pour ordonner
const groups = new Map();
for (const d of livs.docs) {
  const data = d.data();
  if (data.statut === "annulee") continue;
  const tid = data.tourneeId || `solo-${d.id}`;
  if (!groups.has(tid)) groups.set(tid, { tid, datePrevue: null, docs: [], existingNumero: null });
  const g = groups.get(tid);
  g.docs.push(d);
  if (data.tourneeNumero != null) g.existingNumero = data.tourneeNumero;
  const dp = data.datePrevue?.toDate ? data.datePrevue.toDate() : null;
  if (dp && (!g.datePrevue || dp < g.datePrevue)) g.datePrevue = dp;
}

console.log(`Tournées distinctes : ${groups.size}\n`);

// Trie chronologiquement (tournées sans date à la fin) et attribue
const sorted = [...groups.values()].sort((a, b) => {
  const da = a.datePrevue?.getTime() ?? Number.POSITIVE_INFINITY;
  const db_ = b.datePrevue?.getTime() ?? Number.POSITIVE_INFINITY;
  if (da !== db_) return da - db_;
  return a.tid.localeCompare(b.tid);
});

// On préserve les numéros DÉJÀ attribués (pour ne pas casser ce qui marche),
// et on alloue les manquants en partant de max(existant) + 1.
const usedNumeros = new Set(sorted.filter((g) => g.existingNumero != null).map((g) => g.existingNumero));
let nextNum = sorted.length;
for (const g of sorted) {
  if (g.existingNumero != null) continue;
  // Cherche le 1er entier libre en partant de 1
  let n = 1;
  while (usedNumeros.has(n)) n++;
  g.existingNumero = n;
  usedNumeros.add(n);
}

let updates = 0;
const batches = [];
let batch = db.batch();
let batchCount = 0;
for (const g of sorted) {
  const target = g.existingNumero;
  for (const doc of g.docs) {
    if (doc.data().tourneeNumero === target) continue; // déjà à jour
    if (APPLY) {
      batch.update(doc.ref, { tourneeNumero: target });
      batchCount++;
      if (batchCount >= 400) {
        batches.push(batch);
        batch = db.batch();
        batchCount = 0;
      }
    }
    updates++;
  }
}
if (APPLY && batchCount > 0) batches.push(batch);
if (APPLY) {
  for (const b of batches) await b.commit();
}

for (const g of sorted) {
  const dt = g.datePrevue ? g.datePrevue.toISOString().slice(0, 10) : "—";
  console.log(`Tournée n°${String(g.existingNumero).padStart(2)} · ${dt} · ${g.docs.length} livr · ${g.tid}`);
}
console.log(`\nLivraisons à mettre à jour : ${updates}`);
if (!APPLY) console.log("→ Relance avec --apply pour exécuter.");
process.exit(0);
