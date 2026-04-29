/**
 * Applique les 4 corrections sûres validées par Yoann 2026-04-29 :
 *   1) nbVelosCommandes des 5 clients à 381 → vrai count vélos
 *   2) nbVelosCommandes PETIT JOUR 13.25 → 26
 *   3) stats.totalVelos MANI UNIVERS → align sur count vélos réels
 *   4) stats.livres recalculé pour 4 clients désync
 *
 * Sans flag --apply : dry-run uniquement.
 * Usage : node scripts/fix-data-incoherences.mjs --apply
 */
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const APPLY = process.argv.includes("--apply");

const cSnap = await db.collection("clients").get();
const vSnap = await db.collection("velos").get();

const clientsByName = new Map();
const clientsById = new Map();
for (const d of cSnap.docs) {
  const o = d.data();
  clientsById.set(d.id, { id: d.id, ...o });
  const key = String(o.entreprise || "").trim().toUpperCase();
  if (!clientsByName.has(key)) clientsByName.set(key, []);
  clientsByName.get(key).push({ id: d.id, ...o });
}
const velosByClient = new Map();
for (const d of vSnap.docs) {
  const o = d.data();
  if (!o.clientId) continue;
  if (!velosByClient.has(o.clientId)) velosByClient.set(o.clientId, []);
  velosByClient.get(o.clientId).push({ id: d.id, ...o });
}

const findFirst = (entrepriseUpper) => clientsByName.get(entrepriseUpper)?.[0] || null;

const updates = []; // { ref, label, fields }

// === 1) Clients à nbCmd=381 ===
const bug381 = ["LOGISIMA", "SOLUTIONS TRANSPORTS INDUSTRIELS ET LOGIQUE-INTERNATIONAL", "BF LOGISTIQUE", "BILS DEROO SOLUTIONS", "TRANSPORTS FOSSEUX"];
for (const name of bug381) {
  const c = findFirst(name);
  if (!c) { console.log(`  ⚠ ${name} non trouvé`); continue; }
  const vNonAnn = (velosByClient.get(c.id) || []).filter((v) => !v.annule).length;
  if (Number(c.nbVelosCommandes) === 381 && vNonAnn > 0) {
    updates.push({
      ref: db.collection("clients").doc(c.id),
      label: `${name} : nbCmd 381 → ${vNonAnn}`,
      fields: { nbVelosCommandes: vNonAnn, "stats.totalVelos": vNonAnn, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    });
  }
}

// === 2) PETIT JOUR ===
const petitJour = findFirst("PETIT JOUR");
if (petitJour && !Number.isInteger(Number(petitJour.nbVelosCommandes))) {
  const vNonAnn = (velosByClient.get(petitJour.id) || []).filter((v) => !v.annule).length;
  updates.push({
    ref: db.collection("clients").doc(petitJour.id),
    label: `PETIT JOUR : nbCmd ${petitJour.nbVelosCommandes} → ${vNonAnn}`,
    fields: { nbVelosCommandes: vNonAnn, "stats.totalVelos": vNonAnn, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
  });
}

// === 3) MANI UNIVERS ===
const mani = findFirst("MANI UNIVERS");
if (mani) {
  const v = (velosByClient.get(mani.id) || []).filter((x) => !x.annule).length;
  if ((Number(mani.stats?.totalVelos) || 0) !== v) {
    updates.push({
      ref: db.collection("clients").doc(mani.id),
      label: `MANI UNIVERS : stats.totalVelos ${mani.stats?.totalVelos||0} → ${v}`,
      fields: { "stats.totalVelos": v, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    });
  }
}

// === 4) Recalcul stats.livres pour les 4 clients désync ===
const livresClients = ["BARBER SHOP 92", "FRANCE CONSEILS ECOLOGIE", "LES ARTISANS VERTS", "MANADVISE"];
for (const name of livresClients) {
  const c = findFirst(name);
  if (!c) { console.log(`  ⚠ ${name} non trouvé`); continue; }
  const vNonAnn = (velosByClient.get(c.id) || []).filter((v) => !v.annule);
  const livresReels = vNonAnn.filter((v) => v.dateLivraisonScan).length;
  const livresSt = Number(c.stats?.livres) || 0;
  if (livresReels !== livresSt) {
    updates.push({
      ref: db.collection("clients").doc(c.id),
      label: `${name} : stats.livres ${livresSt} → ${livresReels}`,
      fields: { "stats.livres": livresReels, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    });
  }
}

console.log(`\n=== ${updates.length} corrections ${APPLY ? "À APPLIQUER" : "EN DRY-RUN"} ===\n`);
for (const u of updates) console.log(`  ${u.label}`);

if (APPLY && updates.length > 0) {
  console.log("\nApplying…");
  for (const u of updates) {
    await u.ref.update(u.fields);
  }
  console.log(`\n✅ ${updates.length} corrections appliquées.`);
} else if (!APPLY) {
  console.log("\n(dry-run — relance avec --apply pour appliquer)");
}
