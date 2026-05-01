import admin from "firebase-admin";
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const auth = admin.auth();
const db = admin.firestore();

console.log("\n=== Firebase Auth users 'yoann' ===");
const allUsers = [];
let token;
do {
  const page = await auth.listUsers(1000, token);
  allUsers.push(...page.users);
  token = page.pageToken;
} while (token);
const yoanns = allUsers.filter(
  (u) =>
    (u.email || "").toLowerCase().includes("yoann") ||
    (u.email || "").toLowerCase().includes("luzzato"),
);
for (const u of yoanns) {
  console.log(`  uid=${u.uid}  email=${u.email}  lastSignIn=${u.metadata.lastSignInTime}`);
}

console.log("\n=== Firestore equipe 'yoann' ===");
const eq = await db.collection("equipe").get();
for (const d of eq.docs) {
  const data = d.data();
  if (JSON.stringify(data).toLowerCase().match(/yoann|luzzato/)) {
    console.log(`  docId=${d.id}  nom=${data.nom}  email=${data.email}  role=${data.role}  actif=${data.actif}`);
  }
}

console.log("\n=== Match uid → equipe doc ===");
for (const u of yoanns) {
  const snap = await db.collection("equipe").doc(u.uid).get();
  console.log(`  uid=${u.uid} (${u.email}) → ${snap.exists ? "EXISTE" : "❌ MANQUE"}`);
}
process.exit(0);
