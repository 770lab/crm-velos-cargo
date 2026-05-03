import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const v = await db.collection("velos").doc("cmoa7mavv01s2b2g2plfcrsy0").get();
console.log("Vélo BCZ9CANA4D :");
console.log(JSON.stringify(v.data(), null, 2));
process.exit(0);
