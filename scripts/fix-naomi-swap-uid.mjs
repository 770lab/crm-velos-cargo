// Yoann 2026-05-03 : rectif Naomi.
// État actuel (avant ce script) :
//   - JYS3NCBcrhS9YQFm9vodbgnt0j82 : actif=true en /equipe, mais Auth a
//     email=naomi.kingsada@gmail.com (jamais utilisé pour se connecter)
//   - M8K37zfxQ4YjvgbzwflwD7A47HD2 : actif=false en /equipe, mais Auth a
//     email=naomi@artisansverts.energy avec lastSignIn 2/05 (récent)
//
// Naomi se connecte avec naomi@artisansverts.energy → Firebase Auth la
// mappe sur M8K37 → MAIS sa fiche M8K37 est désactivée → bug.
//
// Rectif :
//   1. Activer M8K37 (la fiche qu elle utilise vraiment)
//   2. Désactiver JYS3 (mauvaise fiche)
//   3. Migrer preparateurId / preparateurIds des vélos + livraisons :
//      JYS3 → M8K37 (pour conserver l historique pointage)
//   4. Optionnel : supprimer Firebase Auth JYS3 (l email
//      naomi.kingsada@gmail.com n est pas utilisé)
//
// Idempotent. Mode dry-run par défaut.
//   node scripts/fix-naomi-swap-uid.mjs           # DRY-RUN
//   node scripts/fix-naomi-swap-uid.mjs --apply   # APPLY
//
// SAFETY :
//   - Soft delete (actif=false) JYS3, pas de hard delete
//   - Migration preparateurId : on patch avec timestamp pour audit
//   - Pas de touch à Firebase Auth dans ce script (à faire manuellement
//     en console après validation)
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");

const UID_BON = "M8K37zfxQ4YjvgbzwflwD7A47HD2"; // naomi@artisansverts.energy (Auth réel)
const UID_MAUVAIS = "JYS3NCBcrhS9YQFm9vodbgnt0j82"; // doublon

console.log(`\n=== ${APPLY ? "APPLY" : "DRY-RUN"} fix Naomi swap UID ===\n`);

// 1. Vérifier état actuel
const docBon = await db.collection("equipe").doc(UID_BON).get();
const docMauvais = await db.collection("equipe").doc(UID_MAUVAIS).get();
console.log("Avant :");
console.log(`  ${UID_BON} (BON) : actif=${docBon.exists ? docBon.data().actif : "MANQUE"}`);
console.log(`  ${UID_MAUVAIS} (mauvais) : actif=${docMauvais.exists ? docMauvais.data().actif : "MANQUE"}`);

// 2. Migrer preparateurId sur velos
const velosSnap = await db.collection("velos").where("preparateurId", "==", UID_MAUVAIS).get();
console.log(`\nVélos avec preparateurId=${UID_MAUVAIS} : ${velosSnap.size} à migrer vers ${UID_BON}`);

if (velosSnap.size > 0 && APPLY) {
  let written = 0;
  while (written < velosSnap.size) {
    const slice = velosSnap.docs.slice(written, written + 400);
    const batch = db.batch();
    for (const d of slice) {
      batch.update(d.ref, {
        preparateurId: UID_BON,
        preparateurIdMigrationAt: admin.firestore.FieldValue.serverTimestamp(),
        preparateurIdMigrationFrom: UID_MAUVAIS,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    written += slice.length;
    console.log(`  ✓ batch velos ${written}/${velosSnap.size}`);
  }
}

// 3. Migrer preparateurIds[] sur livraisons (array contains)
const livSnap = await db.collection("livraisons").where("preparateurIds", "array-contains", UID_MAUVAIS).get();
console.log(`\nLivraisons avec preparateurIds ⊃ ${UID_MAUVAIS} : ${livSnap.size} à migrer`);

if (livSnap.size > 0 && APPLY) {
  let written = 0;
  while (written < livSnap.size) {
    const slice = livSnap.docs.slice(written, written + 400);
    const batch = db.batch();
    for (const d of slice) {
      const cur = d.data().preparateurIds || [];
      // Remplace JYS3 par M8K37 (sans dupliquer si M8K37 déjà présent)
      const next = cur.filter((x) => x !== UID_MAUVAIS);
      if (!next.includes(UID_BON)) next.push(UID_BON);
      batch.update(d.ref, {
        preparateurIds: next,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    written += slice.length;
    console.log(`  ✓ batch livraisons ${written}/${livSnap.size}`);
  }
}

// 4. Activer M8K37 + désactiver JYS3
if (APPLY) {
  console.log(`\nActivation ${UID_BON} et désactivation ${UID_MAUVAIS}…`);
  if (docBon.exists) {
    await docBon.ref.update({
      actif: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      reactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
      reactivatedReason: "Fix UID swap Naomi (compte Auth réel utilisé pour login)",
    });
  }
  if (docMauvais.exists) {
    await docMauvais.ref.update({
      actif: false,
      archivedAt: admin.firestore.FieldValue.serverTimestamp(),
      archivedReason: "Doublon Naomi — UID conservé pour audit, vrai compte = M8K37",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  console.log("  ✓ Statuts mis à jour");
}

// 5. Vérif post-apply
if (APPLY) {
  const verifBon = await db.collection("equipe").doc(UID_BON).get();
  const verifMauvais = await db.collection("equipe").doc(UID_MAUVAIS).get();
  console.log("\nAprès :");
  console.log(`  ${UID_BON} (BON) : actif=${verifBon.exists ? verifBon.data().actif : "MANQUE"}`);
  console.log(`  ${UID_MAUVAIS} (mauvais) : actif=${verifMauvais.exists ? verifMauvais.data().actif : "MANQUE"}`);
  // Recompte vélos
  const verifV = await db.collection("velos").where("preparateurId", "==", UID_MAUVAIS).get();
  console.log(`  Vélos preparateurId=mauvais restants : ${verifV.size} (devrait être 0)`);
}

console.log(`\n${APPLY ? "✓" : "(dry-run)"} terminé`);
console.log("\n💡 Action manuelle facultative : supprimer Firebase Auth user");
console.log(`   ${UID_MAUVAIS} (email naomi.kingsada@gmail.com) via console Firebase Auth`);
console.log("   Cet email n est pas utilisé pour le login.");
process.exit(0);
