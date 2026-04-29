import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();

const id = "M8K37zfxQ4YjvgbzwflwD7A47HD2"; // Naomi
await db.collection("equipe").doc(id).update({
  preparateurParDefaut: true,
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
});
console.log(`✅ Naomi (${id}) marquée preparateurParDefaut=true.`);
console.log(`   Toutes les nouvelles tournées créées (createTournee / createTournees) la pré-affecteront automatiquement.`);
