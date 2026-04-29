import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const auth = admin.auth();

const id = "M8K37zfxQ4YjvgbzwflwD7A47HD2";
const email = "naomi@artisansverts.energy";

console.log("=== getUser by uid ===");
try {
  const u = await auth.getUser(id);
  console.log(JSON.stringify(u.toJSON(), null, 2));
} catch (e) {
  console.log(`Error : ${e.code} - ${e.message}`);
}

console.log("\n=== getUserByEmail ===");
try {
  const u = await auth.getUserByEmail(email);
  console.log(`uid=${u.uid} disabled=${u.disabled} verified=${u.emailVerified}`);
  console.log(`providerData=`, u.providerData.map(p => p.providerId));
} catch (e) {
  console.log(`Error : ${e.code} - ${e.message}`);
}

console.log("\n=== listUsers (first 50, recherche par email) ===");
try {
  const list = await auth.listUsers(50);
  for (const u of list.users) {
    if (u.email && u.email.toLowerCase().includes("naomi")) {
      console.log(`Trouvé : uid=${u.uid} email=${u.email} disabled=${u.disabled}`);
    }
  }
} catch (e) {
  console.log(`Error : ${e.code} - ${e.message}`);
}
