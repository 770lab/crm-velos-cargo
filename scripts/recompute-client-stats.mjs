/**
 * Recalcule le bloc `stats` d'un client (ou de tous) à partir des vélos +
 * livraisons effectivement présents en base. Utile après un reset partiel
 * (ex: reset-test-chen-leo.mjs vide les dates des vélos mais ne touche pas
 * aux stats persistées sur le client).
 *
 * Formule alignée sur reset-simulation.mjs (la référence) :
 *   - totalVelos          = vélos non annulés
 *   - livres              = vélos avec dateLivraisonScan
 *   - montes              = vélos avec dateMontage
 *   - certificats         = vélos avec fnuci (proxy "QR scanné")
 *   - planifies           = livraisons statut=planifiee
 *   - totalLivraisonsLivrees = livraisons statut=livree
 *   - blSignes            = livraisons avec urlBlSigne
 *   - facturables / factures : laissés à 0 (logique métier ailleurs)
 *
 * Usage :
 *   node scripts/recompute-client-stats.mjs                   # dry-run, tous
 *   node scripts/recompute-client-stats.mjs --apply           # applique tous
 *   node scripts/recompute-client-stats.mjs --client=cmoa...  # 1 seul client
 *   node scripts/recompute-client-stats.mjs --client=cmoa... --apply
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import admin from "firebase-admin";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
const clientArg = process.argv.find((a) => a.startsWith("--client="));
const ONLY_CLIENT = clientArg ? clientArg.slice("--client=".length) : null;

let cred;
try {
  const sa = JSON.parse(
    readFileSync(join(__dirname, "migration-data", "service-account.json"), "utf8"),
  );
  cred = admin.credential.cert(sa);
} catch {
  cred = admin.credential.applicationDefault();
}
admin.initializeApp({ credential: cred, projectId: "velos-cargo" });
const db = admin.firestore();

function computeStats(velosDocs, livDocs) {
  const velos = velosDocs.filter((d) => !d.data().annule).map((d) => d.data());
  const livs = livDocs.map((d) => d.data());
  return {
    totalVelos: velos.length,
    montes: velos.filter((v) => !!v.dateMontage).length,
    livres: velos.filter((v) => !!v.dateLivraisonScan).length,
    totalLivraisonsLivrees: livs.filter((l) => l.statut === "livree").length,
    blSignes: livs.filter((l) => !!l.urlBlSigne).length,
    facturables: 0,
    planifies: livs.filter((l) => l.statut === "planifiee").length,
    // Flag manuel certificatRecu (aligné sur gas getStats), PAS !!v.fnuci.
    certificats: velos.filter((v) => v.certificatRecu === true).length,
    factures: 0,
  };
}

function diff(oldStats, newStats) {
  const out = [];
  for (const k of Object.keys(newStats)) {
    const o = oldStats?.[k] ?? 0;
    const n = newStats[k];
    if (o !== n) out.push(`${k}: ${o} → ${n}`);
  }
  return out;
}

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY ✍️" : "DRY-RUN 👀"}`);
  console.log(`Cible: ${ONLY_CLIENT ? `client ${ONLY_CLIENT}` : "tous les clients"}\n`);

  const clientsSnap = ONLY_CLIENT
    ? await db.collection("clients").doc(ONLY_CLIENT).get().then((d) => ({ docs: d.exists ? [d] : [] }))
    : await db.collection("clients").get();

  if (!clientsSnap.docs.length) {
    console.error("Aucun client trouvé.");
    process.exit(1);
  }

  let touched = 0;
  let unchanged = 0;
  for (const cd of clientsSnap.docs) {
    const cid = cd.id;
    const cData = cd.data();
    const [vSnap, lSnap] = await Promise.all([
      db.collection("velos").where("clientId", "==", cid).get(),
      db.collection("livraisons").where("clientId", "==", cid).get(),
    ]);
    const newStats = computeStats(vSnap.docs, lSnap.docs);
    const oldStats = cData.stats || {};
    const changes = diff(oldStats, newStats);
    if (changes.length === 0) {
      unchanged++;
      continue;
    }
    touched++;
    console.log(`📌 ${cData.entreprise || cid}  (${cid})`);
    for (const c of changes) console.log(`   - ${c}`);
    if (APPLY) {
      await cd.ref.update({
        stats: newStats,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  console.log(`\n${APPLY ? "✅ Maj effectuée." : "👀 Dry-run terminé."}`);
  console.log(`   ${touched} client(s) à recalculer · ${unchanged} déjà à jour.`);
  if (!APPLY && touched > 0) {
    console.log(`\n→ Relance avec --apply pour appliquer.`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
