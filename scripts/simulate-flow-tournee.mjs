/**
 * SIMULATION FLOW COMPLET sur une tournée — sans étiquettes physiques.
 *
 * Pour chaque livraison de la tournée (sauf celles déjà livrées) :
 *   1. Préparation : assigne un FNUCI synthétique BCSIM* à chaque vélo + datePreparation
 *   2. Chargement  : pose dateChargement
 *   3. Livraison   : pose dateLivraisonScan + (1 BL signé par livraison) urlBlSigne+blNumero+statut=livree
 *   4. Montage     : pose 3 photos montage (URLs synthétiques) + dateMontage + monteParId
 *
 * Marque tout en `simulated: true` pour pouvoir reset propre via
 * scripts/reset-simulation.mjs.
 *
 * Usage :
 *   node scripts/simulate-flow-tournee.mjs              (dry-run)
 *   node scripts/simulate-flow-tournee.mjs --apply
 *   node scripts/simulate-flow-tournee.mjs --apply 818b8963
 */
import admin from "firebase-admin";

admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
const TOURNEE_ID = process.argv.slice(2).filter((a) => !a.startsWith("--"))[0] || "818b8963";
const SIM_USER_ID = "simulation"; // monteParId fictif
const NOW = new Date();
const ts = (offsetSec = 0) => admin.firestore.Timestamp.fromDate(new Date(NOW.getTime() + offsetSec * 1000));

console.log(`Mode  : ${APPLY ? "APPLY ✍️ " : "DRY-RUN 👀"}`);
console.log(`Tournée : ${TOURNEE_ID}\n`);

// Génère un FNUCI synthétique unique au format BC[A-Z0-9]{8} (regex CRM préservée).
// On préfixe BCSIM pour repérer les FNUCI de simulation et permettre le reset.
let fnuciCounter = 1;
function nextFnuci() {
  const n = String(fnuciCounter++).padStart(3, "0");
  return `BCSIM${n}AA`; // ex BCSIM001AA, BCSIM002AA, …
}

// URLs photos synthétiques (placeholder valide ; le frontend les rendra cliquables)
const SIM_PHOTO_URL = "https://firebasestorage.googleapis.com/v0/b/velos-cargo.firebasestorage.app/o/simulation%2Fplaceholder.jpg?alt=media";

const livs = await db.collection("livraisons").where("tourneeId", "==", TOURNEE_ID).get();
if (livs.empty) {
  console.log("Aucune livraison sur cette tournée.");
  process.exit(0);
}

let totalVelos = 0;
let livraisonsTouched = 0;
let velosTouched = 0;
let blNumGenerated = 7000; // commence après les 6 vrais BL

for (const livDoc of livs.docs) {
  const liv = livDoc.data();
  const clientId = liv.clientId;
  const cliEntreprise = liv.clientSnapshot?.entreprise || "?";

  if (liv.statut === "livree") {
    console.log(`⏭️  ${cliEntreprise} déjà livré, skip`);
    continue;
  }

  const vSnap = await db.collection("velos").where("clientId", "==", clientId).get();
  const velos = vSnap.docs.filter((d) => !d.data().annule);
  totalVelos += velos.length;
  if (!velos.length) {
    console.log(`⚠️  ${cliEntreprise} : 0 vélo, skip`);
    continue;
  }

  console.log(`📦 ${cliEntreprise.padEnd(30)} ${velos.length} vélos → simulation prép→charg→livr→montage`);

  if (APPLY) {
    // Update vélos un par un (batch limit Firestore 500 ops, on est à ~50 max → OK en batch unique)
    const batch = db.batch();
    for (const veloDoc of velos) {
      const fnuci = nextFnuci();
      batch.update(veloDoc.ref, {
        fnuci,
        datePreparation: ts(0),
        dateChargement: ts(60),
        dateLivraisonScan: ts(120),
        dateMontage: ts(180),
        monteParId: SIM_USER_ID,
        urlPhotoMontageEtiquette: SIM_PHOTO_URL,
        urlPhotoMontageQrVelo: SIM_PHOTO_URL,
        photoMontageUrl: SIM_PHOTO_URL,
        simulated: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      velosTouched++;
    }
    blNumGenerated++;
    batch.update(livDoc.ref, {
      statut: "livree",
      dateEffective: ts(120),
      urlBlSigne: SIM_PHOTO_URL,
      blNumero: liv.blNumero || `BL-2026-SIM${String(blNumGenerated).padStart(3, "0")}`,
      simulated: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await batch.commit();
    livraisonsTouched++;
  } else {
    velosTouched += velos.length;
    livraisonsTouched++;
  }
}

// Recalcul stats clients (totalVelos, montes, livres, blSignes) — facultatif
// mais important pour que les compteurs des fiches restent cohérents.
if (APPLY) {
  console.log(`\n🔄 Recalcul stats clients touchés…`);
  const clientIds = new Set();
  for (const livDoc of livs.docs) clientIds.add(livDoc.data().clientId);
  for (const cid of clientIds) {
    const vSnap = await db.collection("velos").where("clientId", "==", cid).get();
    const velos = vSnap.docs.filter((d) => !d.data().annule);
    const lvSnap = await db.collection("livraisons").where("clientId", "==", cid).get();
    const lvs = lvSnap.docs.map((d) => d.data());
    const stats = {
      totalVelos: velos.length,
      montes: velos.filter((v) => !!v.data().dateMontage).length,
      livres: velos.filter((v) => !!v.data().dateLivraisonScan).length,
      totalLivraisonsLivrees: lvs.filter((l) => l.statut === "livree").length,
      blSignes: lvs.filter((l) => !!l.urlBlSigne).length,
      facturables: 0,
      planifies: lvs.filter((l) => l.statut === "planifiee").length,
      certificats: velos.filter((v) => !!v.data().fnuci).length,
      factures: 0,
    };
    await db.collection("clients").doc(cid).update({
      stats,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  console.log(`   ${clientIds.size} clients re-statisés.`);
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Livraisons à toucher : ${livraisonsTouched}`);
console.log(`Vélos à toucher      : ${velosTouched} (sur ${totalVelos} total)`);
if (!APPLY) console.log(`\n→ Relance avec --apply pour exécuter.`);
process.exit(0);
