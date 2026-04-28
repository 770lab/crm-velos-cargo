/**
 * Backfill : crée les docs `velos` cibles manquants pour les clients qui ont
 * une livraison Firestore active (statut != annulee/livree) mais 0 vélo doc.
 *
 * Bug 2026-04-28 : `createLivraison` Firestore ne créait pas automatiquement
 * les vélos cibles (modèle A — vélo lié au clientId), du coup les clients
 * créés depuis l'UI Firebase post-migration restaient bloqués à `total=0`
 * en préparation. Fix poussé sur createLivraison ET ce script pour rattraper.
 *
 * Logique : pour chaque client avec livraison(s) active(s), on additionne
 * les nbVelos pending et on crée la différence avec le count actuel de docs
 * velos pour ce client.
 *
 * Idempotent : si le client a déjà ≥ nbVelos demandé, on ne crée rien.
 *
 * Usage:
 *   node scripts/backfill-velos-from-livraisons.mjs              (dry-run)
 *   node scripts/backfill-velos-from-livraisons.mjs --apply
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

// 1) Charge tous les clients (pour récupérer apporteur dénormalisé)
const clientsSnap = await db.collection("clients").get();
const clientsParId = new Map();
for (const d of clientsSnap.docs) {
  const o = d.data();
  clientsParId.set(d.id, {
    apporteur: o.apporteur || null,
    apporteurLower: o.apporteurLower || lower(o.apporteur),
    entreprise: o.entreprise || "",
  });
}

// 2) Charge toutes les livraisons actives
const livSnap = await db.collection("livraisons").get();
const pendingParClient = new Map(); // clientId → nbVelos pending total
for (const d of livSnap.docs) {
  const o = d.data();
  const statut = String(o.statut || "").toLowerCase();
  if (statut === "annulee" || statut === "annulée" || statut === "livree" || statut === "livrée") continue;
  const cid = String(o.clientId || "");
  if (!cid) continue;
  const nb = Number(o.nbVelos) || 0;
  pendingParClient.set(cid, (pendingParClient.get(cid) || 0) + nb);
}

console.log(`Clients avec livraison active : ${pendingParClient.size}`);

// 3) Pour chaque client, compte les vélos existants et crée la différence
let totalACreer = 0;
let totalCrees = 0;
const aTraiter = [...pendingParClient.entries()];

for (const [cid, nbDemande] of aTraiter) {
  const client = clientsParId.get(cid);
  const entreprise = client?.entreprise || cid;
  const velosSnap = await db
    .collection("velos")
    .where("clientId", "==", cid)
    .get();
  const existant = velosSnap.size;
  const aCreer = Math.max(0, nbDemande - existant);
  if (aCreer === 0) continue;
  totalACreer += aCreer;
  console.log(`  ${entreprise} (${cid}) : ${existant} existants, ${nbDemande} demandés → +${aCreer}`);
  if (APPLY) {
    const batch = db.batch();
    for (let i = 0; i < aCreer; i++) {
      const ref = db.collection("velos").doc();
      batch.set(ref, {
        clientId: cid,
        apporteurLower: client?.apporteurLower || null,
        fnuci: null,
        datePreparation: null,
        dateChargement: null,
        dateLivraisonScan: null,
        dateMontage: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    totalCrees += aCreer;
  }
}

console.log(`\nTotal à créer : ${totalACreer}`);
if (APPLY) console.log(`Total créés : ${totalCrees}`);
else console.log(`(dry-run — relance avec --apply pour appliquer)`);
