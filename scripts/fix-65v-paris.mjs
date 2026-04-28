import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
await db.collection("camions").doc("0167bdcc-32de-4df6-8246-2d2fdfe6abc0").update({ peutEntrerParis: false });
const after = await db.collection("camions").doc("0167bdcc-32de-4df6-8246-2d2fdfe6abc0").get();
console.log("65v paris=", after.data().peutEntrerParis);
