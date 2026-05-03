import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const snap = await db.collection("entrepots").where("nom", "==", "Nanterre").get();
if (snap.empty) { console.log("Pas trouvé"); process.exit(1); }
for (const d of snap.docs) {
  console.log(`Avant : ${d.data().adresse} | lat=${d.data().lat ?? "?"} | lng=${d.data().lng ?? "?"}`);
  await d.ref.update({
    adresse: "52 Allée Pierre Lescot",
    lat: 48.898033,
    lng: 2.211017,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`✓ Mis à jour avec lat=48.898033, lng=2.211017, adresse="52 Allée Pierre Lescot"`);
}
process.exit(0);
