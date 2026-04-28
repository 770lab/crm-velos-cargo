/**
 * Nettoyage global avant le go-live du CRM (déploiement logistique réel
 * démarre ce soir). Tous les flags posés pendant les tests doivent
 * redescendre :
 *   - vélos : certificatRecu, facturable, facture, datePreparation,
 *     dateChargement, dateLivraisonScan, dateMontage, photoQrPrise,
 *     monteParId, urlPhotoMontage*, photoMontageUrl
 *   - livraisons : urlBlSigne, numeroBL (les BL séquentiels existants ne
 *     sont pas légitimes), statut→planifiee si ≠ annulee
 *   - clients : recompute stats à partir du nouvel état
 *
 * On ne supprime AUCUN doc, on ne touche pas à la structure (clients,
 * livraisons, vélos restent affiliés). Idempotent.
 *
 * Usage :
 *   node scripts/reset-tests-pre-deploy.mjs            # dry-run
 *   node scripts/reset-tests-pre-deploy.mjs --apply    # exécute
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import admin from "firebase-admin";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");

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

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY ✍️" : "DRY-RUN 👀"}\n`);

  // ---------- VÉLOS ----------
  const velosSnap = await db.collection("velos").get();
  let velosTouched = 0;
  const velosByCertif = velosSnap.docs.filter((d) => d.data().certificatRecu === true);
  const velosByFact = velosSnap.docs.filter((d) => d.data().facturable === true);
  const velosByFacture = velosSnap.docs.filter((d) => d.data().facture === true);
  const velosWithDates = velosSnap.docs.filter((d) => {
    const v = d.data();
    return v.datePreparation || v.dateChargement || v.dateLivraisonScan || v.dateMontage;
  });
  const velosWithPhotos = velosSnap.docs.filter((d) => {
    const v = d.data();
    return v.urlPhotoMontageEtiquette || v.urlPhotoMontageQrVelo || v.photoMontageUrl;
  });

  console.log(`Total vélos en base : ${velosSnap.size}`);
  console.log(`  → certificatRecu=true : ${velosByCertif.length}`);
  console.log(`  → facturable=true     : ${velosByFact.length}`);
  console.log(`  → facture=true        : ${velosByFacture.length}`);
  console.log(`  → avec dates étapes   : ${velosWithDates.length}`);
  console.log(`  → avec photos montage : ${velosWithPhotos.length}`);

  if (APPLY) {
    // Batch 400 par 400 (limite writeBatch=500, on garde marge)
    const docs = velosSnap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const batch = db.batch();
      for (const d of docs.slice(i, i + 400)) {
        batch.update(d.ref, {
          certificatRecu: false,
          facturable: false,
          facture: false,
          datePreparation: null,
          dateChargement: null,
          dateLivraisonScan: null,
          dateMontage: null,
          photoQrPrise: false,
          monteParId: null,
          urlPhotoMontageEtiquette: null,
          urlPhotoMontageQrVelo: null,
          photoMontageUrl: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        velosTouched++;
      }
      await batch.commit();
    }
    console.log(`\n✅ ${velosTouched} vélos reset.`);
  }

  // ---------- LIVRAISONS ----------
  const livSnap = await db.collection("livraisons").get();
  const livWithBl = livSnap.docs.filter((d) => !!d.data().urlBlSigne);
  const livWithNum = livSnap.docs.filter((d) => !!d.data().numeroBL);
  const livLivrees = livSnap.docs.filter((d) => d.data().statut === "livree");
  console.log(`\nTotal livraisons : ${livSnap.size}`);
  console.log(`  → avec urlBlSigne     : ${livWithBl.length}`);
  console.log(`  → avec numeroBL       : ${livWithNum.length}`);
  console.log(`  → statut=livree       : ${livLivrees.length}`);

  if (APPLY) {
    let livTouched = 0;
    const docs = livSnap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const batch = db.batch();
      for (const d of docs.slice(i, i + 400)) {
        const data = d.data();
        // Repasser à planifiee uniquement si pas annulée (on ne ressuscite
        // pas une livraison volontairement annulée).
        const updates = {
          urlBlSigne: null,
          numeroBL: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (data.statut === "livree") {
          updates.statut = "planifiee";
          updates.dateEffective = null;
        }
        batch.update(d.ref, updates);
        livTouched++;
      }
      await batch.commit();
    }
    console.log(`✅ ${livTouched} livraisons reset (BL signé + numeroBL vidés, statut livree→planifiee).`);
  }

  // Reset aussi le counter BL pour repartir de BL-YYYY-00001 dès ce soir.
  if (APPLY) {
    const year = String(new Date().getFullYear());
    await db.collection("counters").doc(`bl-${year}`).set(
      { next: 0, year, resetAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true },
    );
    console.log(`✅ Counter BL ${year} remis à 0.`);
  }

  // ---------- CLIENTS : recompute stats ----------
  const clientsSnap = await db.collection("clients").get();
  console.log(`\nTotal clients : ${clientsSnap.size} (recompute stats à partir du nouvel état)`);

  if (APPLY) {
    // Re-charger vélos et livraisons après l'update pour avoir l'état frais.
    const [vAll, lAll] = await Promise.all([
      db.collection("velos").get(),
      db.collection("livraisons").get(),
    ]);
    const velosByClient = {};
    for (const d of vAll.docs) {
      const v = d.data();
      if (v.annule) continue;
      const cid = v.clientId;
      if (!cid) continue;
      (velosByClient[cid] ||= []).push(v);
    }
    const livsByClient = {};
    for (const d of lAll.docs) {
      const l = d.data();
      const cid = l.clientId;
      if (!cid) continue;
      (livsByClient[cid] ||= []).push(l);
    }
    let clientsTouched = 0;
    for (let i = 0; i < clientsSnap.docs.length; i += 400) {
      const batch = db.batch();
      for (const cd of clientsSnap.docs.slice(i, i + 400)) {
        const velos = velosByClient[cd.id] || [];
        const livs = livsByClient[cd.id] || [];
        const newStats = {
          totalVelos: velos.length,
          montes: velos.filter((v) => !!v.dateMontage).length, // → 0 partout après ce reset
          livres: velos.filter((v) => !!v.dateLivraisonScan).length,
          totalLivraisonsLivrees: livs.filter((l) => l.statut === "livree").length,
          blSignes: livs.filter((l) => !!l.urlBlSigne).length,
          facturables: 0,
          planifies: livs.filter((l) => l.statut === "planifiee").length,
          // Aligné sur gas getStats : certificatRecu est le flag manuel
          // posé quand on reçoit le certificat Bicycle/FNUCI papier. !!v.fnuci
          // (utilisé par reset-simulation.mjs) compte les QR scannés, pas les
          // certificats — ne pas confondre.
          certificats: velos.filter((v) => v.certificatRecu === true).length,
          factures: 0,
        };
        batch.update(cd.ref, {
          stats: newStats,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        clientsTouched++;
      }
      await batch.commit();
    }
    console.log(`✅ ${clientsTouched} clients : stats recomputées.`);
  }

  if (!APPLY) {
    console.log(`\n👉 Relance avec --apply pour exécuter.`);
  } else {
    console.log(`\n🎉 Reset pré-deploy terminé. CRM prêt à démarrer ce soir avec un état propre.`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
