// Diag mismatch UID Firebase Auth ↔ doc equipe Firestore (30-04 09h55).
// Naomi se logge correctement (Firebase Auth OK) mais voit "Accès refusé"
// → son user.uid ne match aucun doc dans equipe/. On cherche tous les comptes
// "naomi*" dans Firebase Auth ET dans equipe pour identifier le mismatch.
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});

const auth = admin.auth();
const db = admin.firestore();

console.log("\n=== Firebase Auth users (recherche 'naomi') ===");
const allUsers = [];
let nextPageToken;
do {
  const page = await auth.listUsers(1000, nextPageToken);
  allUsers.push(...page.users);
  nextPageToken = page.pageToken;
} while (nextPageToken);

const naomiUsers = allUsers.filter(
  (u) =>
    (u.email || "").toLowerCase().includes("naomi") ||
    (u.displayName || "").toLowerCase().includes("naomi"),
);
for (const u of naomiUsers) {
  console.log(`  uid=${u.uid}  email=${u.email}  created=${u.metadata.creationTime}  lastSignIn=${u.metadata.lastSignInTime}`);
}
if (naomiUsers.length === 0) console.log("  (aucun)");

console.log("\n=== Firestore equipe (recherche 'naomi' dans nom/email) ===");
const eqSnap = await db.collection("equipe").get();
for (const d of eqSnap.docs) {
  const data = d.data();
  const blob = JSON.stringify(data).toLowerCase();
  if (blob.includes("naomi")) {
    console.log(`  docId=${d.id}  nom=${data.nom}  email=${data.email}  role=${data.role}  actif=${data.actif}`);
  }
}

console.log("\n=== Match : pour chaque user Firebase 'naomi', existe-t-il equipe/${uid} ? ===");
for (const u of naomiUsers) {
  const docRef = db.collection("equipe").doc(u.uid);
  const docSnap = await docRef.get();
  console.log(`  uid=${u.uid} (${u.email}) → equipe/${u.uid} ${docSnap.exists ? "EXISTE" : "❌ MANQUE"}`);
}

process.exit(0);
