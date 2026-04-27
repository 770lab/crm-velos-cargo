/**
 * Audit complet CHEN LEO post-test : on dumpe TOUS les champs des docs Firestore
 * (vélos + livraison + photos URL) pour vérifier que rien ne s'est perdu pendant
 * la migration GAS → Firestore et que la fiche client a tout pour l'admin CEE.
 */
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const CLIENT_ID = "cmoa7maty01hqb2g2laqluwu4";

function fmt(ts) {
  if (!ts) return "—";
  if (ts.toDate) return ts.toDate().toISOString();
  return String(ts);
}

console.log("=".repeat(72));
console.log("CLIENT");
console.log("=".repeat(72));
const cli = await db.collection("clients").doc(CLIENT_ID).get();
if (!cli.exists) {
  console.log("⚠️  Client introuvable !");
  process.exit(1);
}
console.log(JSON.stringify(cli.data(), null, 2));

console.log("\n" + "=".repeat(72));
console.log("VÉLOS");
console.log("=".repeat(72));
const velos = await db.collection("velos").where("clientId", "==", CLIENT_ID).get();
console.log(`Total : ${velos.size}\n`);
for (const d of velos.docs) {
  const v = d.data();
  console.log(`--- ${d.id} ---`);
  console.log(`  fnuci             : ${v.fnuci || "—"}`);
  console.log(`  annule            : ${!!v.annule}`);
  console.log(`  datePreparation   : ${fmt(v.datePreparation)}`);
  console.log(`  dateChargement    : ${fmt(v.dateChargement)}`);
  console.log(`  dateLivraisonScan : ${fmt(v.dateLivraisonScan)}`);
  console.log(`  dateMontage       : ${fmt(v.dateMontage)}`);
  console.log(`  monteParId        : ${v.monteParId || "—"}`);
  console.log(`  urlPhotoMontageEtiquette : ${v.urlPhotoMontageEtiquette || "—"}`);
  console.log(`  urlPhotoMontageQrVelo    : ${v.urlPhotoMontageQrVelo || "—"}`);
  console.log(`  photoMontageUrl          : ${v.photoMontageUrl || "—"}`);
  // Tous les autres champs au cas où
  const known = new Set([
    "fnuci","annule","datePreparation","dateChargement","dateLivraisonScan","dateMontage",
    "monteParId","urlPhotoMontageEtiquette","urlPhotoMontageQrVelo","photoMontageUrl",
    "clientId","createdAt","updatedAt","veloId","tourneeId","preparePar","chargePar","livrePar",
  ]);
  const extras = Object.keys(v).filter((k) => !known.has(k));
  if (extras.length) {
    console.log(`  + autres champs   : ${extras.join(", ")}`);
    for (const k of extras) console.log(`      ${k} = ${JSON.stringify(v[k])}`);
  }
  console.log("");
}

console.log("=".repeat(72));
console.log("LIVRAISONS");
console.log("=".repeat(72));
const livs = await db.collection("livraisons").where("clientId", "==", CLIENT_ID).get();
console.log(`Total : ${livs.size}\n`);
for (const d of livs.docs) {
  const l = d.data();
  console.log(`--- ${d.id} ---`);
  console.log(JSON.stringify(l, (_, v) => (v && v._seconds ? new Date(v._seconds * 1000).toISOString() : v), 2));
  console.log("");
}

console.log("=".repeat(72));
console.log("PHOTOS DANS DES SOUS-COLLECTIONS / AUTRES COLLECTIONS");
console.log("=".repeat(72));
// Cherche dans des collections classiques utilisées pour stocker les photos
for (const coll of ["photos", "photosClient", "documents", "bls"]) {
  try {
    const s = await db.collection(coll).where("clientId", "==", CLIENT_ID).get();
    if (s.size) {
      console.log(`\n[${coll}] ${s.size} doc(s)`);
      for (const d of s.docs) console.log(`  ${d.id} → ${JSON.stringify(d.data())}`);
    } else {
      console.log(`[${coll}] vide`);
    }
  } catch (e) {
    console.log(`[${coll}] introuvable (${e.code || e.message})`);
  }
}

process.exit(0);
