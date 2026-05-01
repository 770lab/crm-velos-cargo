// Fix hallucination Gemini S↔5 sur DOSTLAR FRANCE.
// BCH22CESHD (en base) -> BCH22CE5HD (vrai FNUCI sticker).
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const VELO_ID = "cmoa7mb1d032cb2g2r829svzj";
const OLD = "BCH22CESHD";
const NEW = "BCH22CE5HD";

console.log(`\n=== Fix FNUCI ${OLD} -> ${NEW} ===\n`);

const existSnap = await db.collection("velos").where("fnuci", "==", NEW).get();
if (!existSnap.empty) {
  console.error(`❌ DOUBLON : ${NEW} existe déjà sur ${existSnap.size} vélo(s). Abort.`);
  for (const d of existSnap.docs) console.error(`   - veloId=${d.id} clientId=${d.data().clientId}`);
  process.exit(1);
}

const veloRef = db.collection("velos").doc(VELO_ID);
const veloSnap = await veloRef.get();
if (!veloSnap.exists) { console.error(`❌ veloId ${VELO_ID} introuvable. Abort.`); process.exit(1); }
const v = veloSnap.data();
if (v.fnuci !== OLD) {
  console.error(`❌ FNUCI actuel = ${v.fnuci}, attendu ${OLD}. Abort.`);
  process.exit(1);
}

console.log(`✓ Vélo trouvé chez clientId=${v.clientId}`);
console.log(`✓ Aucun doublon de ${NEW}\n`);

await veloRef.update({
  fnuci: NEW,
  fnuciPrevious: OLD,
  fnuciFixedAt: admin.firestore.FieldValue.serverTimestamp(),
  fnuciFixedReason: "Hallucination Gemini S vs 5 — Yoann manual fix 2026-05-01",
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
});

console.log(`✓ Corrigé : veloId=${VELO_ID}  ${OLD} -> ${NEW}\n`);
process.exit(0);
