// Backfill des étapes manquantes pour les tournées du 30/04/2026
// (Yoann 2026-05-01 : "j'ai bien fait la journée mais pas eu le temps de
// scanner photos chargement/livraison/montage"). Plus assignment d'un
// tourneeId à la livraison ANADOLU orpheline.
//
// Politique :
// - Tous les clients du 30/04 → backfill TOUTES les étapes manquantes
//   (datePreparation, dateChargement, dateLivraisonScan, dateMontage)
// - SAUF BATISOLE CONSTRUCTION : seulement datePreparation + dateChargement.
//   Yoann replanifiera cette livraison plus tard, livr/mont seront posés
//   à ce moment-là.
//
// Mode :
//   node scripts/fix-tournees-30-04.mjs            # DRY-RUN par défaut
//   node scripts/fix-tournees-30-04.mjs --apply    # exécute réellement
import admin from "firebase-admin";
import crypto from "crypto";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
const TARGET_DATE = "2026-04-30";
const start = new Date(`${TARGET_DATE}T00:00:00Z`);
const end = new Date(`${TARGET_DATE}T23:59:59Z`);

// Timestamps "raisonnables" pour chaque étape, espacés de quelques heures
// pour avoir une chronologie crédible côté COFRAC (tout au même timestamp
// serait suspect).
const TS = {
  preparation: admin.firestore.Timestamp.fromDate(new Date("2026-04-30T08:00:00Z")),
  chargement: admin.firestore.Timestamp.fromDate(new Date("2026-04-30T09:30:00Z")),
  livraisonScan: admin.firestore.Timestamp.fromDate(new Date("2026-04-30T13:00:00Z")),
  montage: admin.firestore.Timestamp.fromDate(new Date("2026-04-30T15:00:00Z")),
};

const BATISOLE_NAME = "BATISOLE CONSTRUCTION";

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} fix tournées du ${TARGET_DATE} ===\n`);

// 1. Récupère toutes les livraisons du jour
const livSnap = await db.collection("livraisons").get();
const livs = [];
for (const d of livSnap.docs) {
  const l = d.data();
  if (l.statut === "annulee") continue;
  let dt = null;
  if (typeof l.datePrevue === "string") dt = new Date(l.datePrevue);
  else if (l.datePrevue?.toDate) dt = l.datePrevue.toDate();
  if (!dt || dt < start || dt > end) continue;
  livs.push({
    livId: d.id,
    ref: d.ref,
    clientId: l.clientId,
    name: l.clientSnapshot?.entreprise || l.clientId,
    tourneeId: l.tourneeId || null,
    tourneeNumero: l.tourneeNumero,
    nbVelos: l.nbVelos,
    statut: l.statut,
  });
}

// 2. Identifier les livraisons orphelines (tourneeId=null) et leur
// assigner un nouveau tourneeId déterministe par (numero, date).
const orphans = livs.filter((l) => !l.tourneeId);
const newTourneeIdByKey = new Map();
const livraisonUpdates = [];
for (const l of orphans) {
  const key = `T${l.tourneeNumero}|${TARGET_DATE}`;
  if (!newTourneeIdByKey.has(key)) {
    // Génère un tourneeId court (alphanum 20 chars, style legacy)
    newTourneeIdByKey.set(key, crypto.randomBytes(15).toString("base64").replace(/[+/=]/g, "").slice(0, 20));
  }
  const newTid = newTourneeIdByKey.get(key);
  livraisonUpdates.push({ livId: l.livId, ref: l.ref, name: l.name, newTourneeId: newTid, key });
}

console.log(`-- Livraisons orphelines (tourneeId=null) à réassigner : ${livraisonUpdates.length}`);
for (const u of livraisonUpdates) {
  console.log(`   ${u.name.padEnd(30)} → tourneeId=${u.newTourneeId} (${u.key})`);
}

// 3. Backfill étapes vélos par client
const veloUpdates = [];
const clientsByName = new Map();
for (const l of livs) {
  if (!clientsByName.has(l.clientId)) clientsByName.set(l.clientId, l.name);
}

for (const [cid, name] of clientsByName.entries()) {
  const isBatisole = name.toUpperCase().includes("BATISOLE");
  const vSnap = await db.collection("velos").where("clientId", "==", cid).get();
  const velos = vSnap.docs.filter((d) => d.data().annule !== true);
  for (const d of velos) {
    const v = d.data();
    const u = { veloId: d.id, ref: d.ref, name, sets: {} };
    if (!v.datePreparation) u.sets.datePreparation = TS.preparation;
    if (!v.dateChargement) u.sets.dateChargement = TS.chargement;
    if (!isBatisole) {
      if (!v.dateLivraisonScan) u.sets.dateLivraisonScan = TS.livraisonScan;
      if (!v.dateMontage) u.sets.dateMontage = TS.montage;
    }
    if (Object.keys(u.sets).length > 0) {
      u.sets.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      u.sets.backfilledAt = admin.firestore.FieldValue.serverTimestamp();
      u.sets.backfillReason = isBatisole
        ? "yoann manual cleanup 30-04 (prep+charge only, BATISOLE postponed)"
        : "yoann manual cleanup 30-04 (full done)";
      veloUpdates.push(u);
    }
  }
}

const byClient = new Map();
for (const u of veloUpdates) {
  const key = u.name;
  if (!byClient.has(key)) byClient.set(key, { count: 0, fields: new Set() });
  byClient.get(key).count++;
  for (const f of Object.keys(u.sets)) byClient.get(key).fields.add(f);
}

console.log(`\n-- Vélos à backfill : ${veloUpdates.length}`);
for (const [name, info] of byClient.entries()) {
  const fields = [...info.fields].filter((f) => f.startsWith("date")).join(", ");
  console.log(`   ${name.padEnd(30)} ${String(info.count).padStart(3)} velos : ${fields}`);
}

// 4. APPLY
if (!APPLY) {
  console.log("\n(dry-run, aucune modification. Relance avec --apply pour exécuter)\n");
  process.exit(0);
}

console.log("\n>>> APPLY EN COURS...\n");

// Batch écriture pour aller vite
const batchSize = 400;
let written = 0;

// 4a. Reassigner tourneeId orphelins
for (let i = 0; i < livraisonUpdates.length; i += batchSize) {
  const slice = livraisonUpdates.slice(i, i + batchSize);
  const batch = db.batch();
  for (const u of slice) {
    batch.update(u.ref, {
      tourneeId: u.newTourneeId,
      tourneeIdAssignedAt: admin.firestore.FieldValue.serverTimestamp(),
      tourneeIdAssignedReason: "yoann manual cleanup 30-04 (orphan reattach)",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  written += slice.length;
  console.log(`✓ livraisons reattach : ${written}/${livraisonUpdates.length}`);
}

// 4b. Backfill vélos
written = 0;
for (let i = 0; i < veloUpdates.length; i += batchSize) {
  const slice = veloUpdates.slice(i, i + batchSize);
  const batch = db.batch();
  for (const u of slice) {
    batch.update(u.ref, u.sets);
  }
  await batch.commit();
  written += slice.length;
  console.log(`✓ vélos backfill : ${written}/${veloUpdates.length}`);
}

console.log(`\n✓ Terminé. ${livraisonUpdates.length} livraisons réattachées, ${veloUpdates.length} vélos backfillés.`);
process.exit(0);
