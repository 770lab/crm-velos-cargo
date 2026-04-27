/**
 * Réinitialise le test fait sur CHEN LEO :
 *   - 3 vélos (FNUCI BCZ9CANA4D, BC38FKZZ7H, BCA24SN97A)
 *   - Désaffilie du client + supprime FNUCI + reset dates prép/charg/livr/mont
 *   - Reset statut de la livraison/tournée du client si nécessaire
 *
 * Usage :
 *   node scripts/reset-test-chen-leo.mjs            # dry-run
 *   node scripts/reset-test-chen-leo.mjs --apply    # exécute
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import admin from "firebase-admin";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");

const CLIENT_ID = "cmoa7maty01hqb2g2laqluwu4"; // CHEN LEO
const TOURNEE_ID = "818b8963";
const FNUCIS = ["BCZ9CANA4D", "BC38FKZZ7H", "BCA24SN97A"];

const sa = JSON.parse(
  readFileSync(join(__dirname, "migration-data", "service-account.json"), "utf8"),
);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

async function main() {
  console.log(`Mode: ${APPLY ? "APPLY ✍️" : "DRY-RUN 👀"}`);
  console.log(`Client: ${CLIENT_ID}, tournée: ${TOURNEE_ID}`);
  console.log(`FNUCI à reset: ${FNUCIS.join(", ")}\n`);

  // 1) Trouver les vélos par FNUCI
  const velosSnap = await db
    .collection("velos")
    .where("fnuci", "in", FNUCIS)
    .get();

  console.log(`Vélos trouvés par FNUCI: ${velosSnap.size}`);
  for (const d of velosSnap.docs) {
    const v = d.data();
    console.log(
      `  - ${d.id}  fnuci=${v.fnuci}  clientId=${v.clientId || "—"}  prep=${!!v.datePreparation}  charg=${!!v.dateChargement}  livr=${!!v.dateLivraisonScan}  mont=${!!v.dateMontage}`,
    );
  }

  // 2) Aussi : tous les vélos liés au client (au cas où FNUCI vidé mais clientId resté)
  const byClientSnap = await db
    .collection("velos")
    .where("clientId", "==", CLIENT_ID)
    .get();
  const extraIds = byClientSnap.docs
    .filter((d) => !velosSnap.docs.some((v) => v.id === d.id))
    .map((d) => d.id);
  if (extraIds.length) {
    console.log(`\nVélos en plus liés au client (sans FNUCI matchant): ${extraIds.length}`);
    extraIds.forEach((id) => console.log(`  - ${id}`));
  }

  const allDocs = [...velosSnap.docs, ...byClientSnap.docs.filter((d) => extraIds.includes(d.id))];

  // 3) Reset
  if (APPLY) {
    const batch = db.batch();
    for (const d of allDocs) {
      batch.update(d.ref, {
        clientId: null,
        fnuci: null,
        datePreparation: null,
        dateChargement: null,
        dateLivraisonScan: null,
        dateMontage: null,
        photoMontageUrl: null,
        photoEtiquetteUrl: null,
        photoBicyCodeUrl: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    console.log(`\n✅ ${allDocs.length} vélos reset.`);
  }

  // 4) Reset le statut de la livraison du client (si "livree" → "planifiee")
  const livSnap = await db
    .collection("livraisons")
    .where("tourneeId", "==", TOURNEE_ID)
    .where("clientId", "==", CLIENT_ID)
    .get();
  console.log(`\nLivraisons du client dans la tournée: ${livSnap.size}`);
  for (const d of livSnap.docs) {
    const l = d.data();
    console.log(`  - ${d.id}  statut=${l.statut}  dateEffective=${l.dateEffective ? "set" : "—"}`);
  }
  if (APPLY) {
    const batch = db.batch();
    for (const d of livSnap.docs) {
      batch.update(d.ref, {
        statut: "planifiee",
        dateEffective: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    console.log(`✅ ${livSnap.size} livraison(s) repassée(s) à "planifiee".`);
  }

  if (!APPLY) {
    console.log(`\n👉 Relance avec --apply pour exécuter.`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
