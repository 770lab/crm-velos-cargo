import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const list = await admin.auth().listUsers(100);
for (const u of list.users) {
  if (u.email && (u.email.includes("yoann") || u.email.includes("chabadclub"))) {
    console.log(`  uid=${u.uid} email=${u.email} disabled=${u.disabled}`);
  }
}
process.exit(0);
