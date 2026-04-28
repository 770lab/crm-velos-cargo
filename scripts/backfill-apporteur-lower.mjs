/**
 * Backfill du champ dénormalisé `apporteurLower` sur les docs clients +
 * livraisons + velos Firestore. Sert au matching case-insensitive du RBAC
 * apporteur (Firestore Rules ne supporte pas la comparaison .lower() côté
 * query, donc on matérialise un champ pré-normalisé).
 *
 * Règle de normalisation : `(apporteur || "").trim().toLowerCase()`. Espaces
 * doubles préservés (peu probable mais on touche à rien). Apporteur null/vide
 * → champ apporteurLower absent (le doc reste invisible aux apporteurs).
 *
 * Pour livraisons et velos, on lit l'apporteur depuis le doc client (jointure
 * sur clientId) — c'est la source de vérité côté commercial. Si un client
 * change d'apporteur plus tard, il faudra re-runner ce script.
 *
 * Usage:
 *   node scripts/backfill-apporteur-lower.mjs              (dry-run)
 *   node scripts/backfill-apporteur-lower.mjs --apply
 */
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
console.log(`Mode : ${APPLY ? "APPLY ✍️ " : "DRY-RUN 👀"}\n`);

function lower(s) {
  if (s == null) return null;
  const v = String(s).trim().toLowerCase();
  return v || null;
}

// 1. Clients : source de vérité
console.log("=== CLIENTS ===");
const clientsSnap = await db.collection("clients").get();
console.log(`Total clients : ${clientsSnap.size}`);

const clientApporteur = new Map(); // clientId -> apporteurLower
let needsUpdateClients = 0;
for (const d of clientsSnap.docs) {
  const data = d.data();
  const aLower = lower(data.apporteur);
  if (aLower) clientApporteur.set(d.id, aLower);
  if (data.apporteurLower !== aLower) needsUpdateClients++;
}
console.log(`Clients à update apporteurLower : ${needsUpdateClients}`);

if (APPLY && needsUpdateClients > 0) {
  let batch = db.batch();
  let n = 0;
  for (const d of clientsSnap.docs) {
    const data = d.data();
    const aLower = lower(data.apporteur);
    if (data.apporteurLower !== aLower) {
      batch.update(d.ref, { apporteurLower: aLower });
      n++;
      if (n % 400 === 0) {
        await batch.commit();
        batch = db.batch();
      }
    }
  }
  if (n % 400 !== 0) await batch.commit();
  console.log(`✅ ${n} clients updatés`);
}

// 2. Livraisons : jointure via clientId → apporteur du client
console.log("\n=== LIVRAISONS ===");
const livsSnap = await db.collection("livraisons").get();
console.log(`Total livraisons : ${livsSnap.size}`);

let needsUpdateLivs = 0;
let orphanLivs = 0;
for (const d of livsSnap.docs) {
  const data = d.data();
  const cid = data.clientId;
  if (!cid) { orphanLivs++; continue; }
  const aLower = clientApporteur.get(cid) || null;
  if (data.apporteurLower !== aLower) needsUpdateLivs++;
}
console.log(`Livraisons à update : ${needsUpdateLivs}`);
console.log(`Livraisons sans clientId (skipped) : ${orphanLivs}`);

if (APPLY && needsUpdateLivs > 0) {
  let batch = db.batch();
  let n = 0;
  for (const d of livsSnap.docs) {
    const data = d.data();
    const cid = data.clientId;
    if (!cid) continue;
    const aLower = clientApporteur.get(cid) || null;
    if (data.apporteurLower !== aLower) {
      batch.update(d.ref, { apporteurLower: aLower });
      n++;
      if (n % 400 === 0) {
        await batch.commit();
        batch = db.batch();
      }
    }
  }
  if (n % 400 !== 0) await batch.commit();
  console.log(`✅ ${n} livraisons updatées`);
}

// 3. Velos : jointure via clientId
console.log("\n=== VELOS ===");
const velosSnap = await db.collection("velos").get();
console.log(`Total velos : ${velosSnap.size}`);

let needsUpdateVelos = 0;
let orphanVelos = 0;
for (const d of velosSnap.docs) {
  const data = d.data();
  const cid = data.clientId;
  if (!cid) { orphanVelos++; continue; }
  const aLower = clientApporteur.get(cid) || null;
  if (data.apporteurLower !== aLower) needsUpdateVelos++;
}
console.log(`Velos à update : ${needsUpdateVelos}`);
console.log(`Velos sans clientId (skipped) : ${orphanVelos}`);

if (APPLY && needsUpdateVelos > 0) {
  let batch = db.batch();
  let n = 0;
  for (const d of velosSnap.docs) {
    const data = d.data();
    const cid = data.clientId;
    if (!cid) continue;
    const aLower = clientApporteur.get(cid) || null;
    if (data.apporteurLower !== aLower) {
      batch.update(d.ref, { apporteurLower: aLower });
      n++;
      if (n % 400 === 0) {
        await batch.commit();
        batch = db.batch();
      }
    }
  }
  if (n % 400 !== 0) await batch.commit();
  console.log(`✅ ${n} velos updatés`);
}

console.log("\n=== DONE ===");
