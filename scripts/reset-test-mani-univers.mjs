/**
 * Réinitialise le test fait sur MANI UNIVERS (1 vélo, FNUCI BC6AHEK88E, prép 27/04/2026 11:12).
 * Usage : node scripts/reset-test-mani-univers.mjs --apply
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import admin from "firebase-admin";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");

const CLIENT_ID = "cmoa7mb4w03z4b2g2x0sdxjy8";
const FNUCIS = ["BC6AHEK88E"];

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

console.log(`Mode: ${APPLY ? "APPLY ✍️" : "DRY-RUN 👀"}\n`);

const velosSnap = await db.collection("velos").where("fnuci", "in", FNUCIS).get();
const byClientSnap = await db.collection("velos").where("clientId", "==", CLIENT_ID).get();
const allDocs = [
  ...velosSnap.docs,
  ...byClientSnap.docs.filter((d) => !velosSnap.docs.some((v) => v.id === d.id)),
];

console.log(`Vélos à reset: ${allDocs.length}`);
for (const d of allDocs) {
  const v = d.data();
  console.log(`  - ${d.id}  fnuci=${v.fnuci}  prep=${!!v.datePreparation}`);
}

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
      urlPhotoMontageEtiquette: null,
      urlPhotoMontageQrVelo: null,
      photoMontageUrl: null,
      monteParId: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  console.log(`\n✅ ${allDocs.length} vélo(s) reset.`);

  // Reset livraisons "livree" éventuelles pour ce client
  const livSnap = await db
    .collection("livraisons")
    .where("clientId", "==", CLIENT_ID)
    .get();
  const toReset = livSnap.docs.filter((d) => d.data().statut === "livree");
  if (toReset.length) {
    const b2 = db.batch();
    for (const d of toReset) {
      b2.update(d.ref, {
        statut: "planifiee",
        dateEffective: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await b2.commit();
    console.log(`✅ ${toReset.length} livraison(s) repassée(s) à "planifiee".`);
  }
} else {
  console.log("\n👉 Relance avec --apply.");
}
process.exit(0);
