import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const auth = admin.auth();

const uid = "M8K37zfxQ4YjvgbzwflwD7A47HD2";
const PIN = process.argv[2] || "1234";
if (!/^\d{4}$/.test(PIN)) { console.log("PIN doit être 4 chiffres"); process.exit(1); }

await auth.updateUser(uid, {
  email: "naomi@artisansverts.energy",
  emailVerified: false,
  displayName: "Naomi",
  password: `vc-${PIN}`,
  disabled: false,
});
console.log(`✅ User Auth ${uid} réassigné à Naomi (email=naomi@artisansverts.energy, PIN=${PIN})`);
console.log(`   Naomi peut maintenant se connecter : identifiant "naomi" + PIN ${PIN}`);
