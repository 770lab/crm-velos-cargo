import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
await db.collection("camions").doc("f6baa591-eaad-46f4-9ea9-5516d97fcbba").update({ capaciteVelos: 132 });
const after = await db.collection("camions").doc("f6baa591-eaad-46f4-9ea9-5516d97fcbba").get();
console.log("Mis à jour :", after.data());
