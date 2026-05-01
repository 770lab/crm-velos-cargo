// Naomi a 2 comptes Firebase Auth (un Gmail perso + un email Workspace).
// Le doc equipe n'est que sous l'uid Workspace. Quand elle se logge avec
// Google sur son Samsung, c'est son compte Gmail perso qui passe -> uid
// orphelin -> "Acces refuse". Fix : copier le doc equipe sous les 2 uids.
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});

const db = admin.firestore();

const SOURCE_UID = "M8K37zfxQ4YjvgbzwflwD7A47HD2"; // naomi@artisansverts.energy (a deja le doc)
const TARGET_UID = "JYS3NCBcrhS9YQFm9vodbgnt0j82"; // naomi.kingsada@gmail.com (orphelin)

const srcSnap = await db.collection("equipe").doc(SOURCE_UID).get();
if (!srcSnap.exists) {
  console.error("❌ Doc source introuvable, abort");
  process.exit(1);
}
const srcData = srcSnap.data();
console.log("Source :", { uid: SOURCE_UID, ...srcData });

await db
  .collection("equipe")
  .doc(TARGET_UID)
  .set({
    ...srcData,
    // legacyId pointe sur l'uid source pour traçabilité (Yoann pourra plus tard
    // décider lequel garder).
    legacyId: SOURCE_UID,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

const verif = await db.collection("equipe").doc(TARGET_UID).get();
console.log(`✅ Doc clone cree sous equipe/${TARGET_UID}`);
console.log(verif.data());

process.exit(0);
