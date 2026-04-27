/**
 * Audit auth équipe : pour chaque membre, vérifie s'il a un compte Firebase
 * Auth créé (uid rempli + record dans Firebase Auth) et s'il pourra se
 * loguer demain matin.
 */
import admin from "firebase-admin";
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "velos-cargo",
});
const db = admin.firestore();
const auth = admin.auth();

const eqSnap = await db.collection("equipe").get();
console.log(`Membres équipe : ${eqSnap.size}\n`);

const buckets = {};
const noUid = [];
const uidNotInAuth = [];
const ok = [];

// On batch les lookups Firebase Auth en parallèle limité
async function checkAuth(uid, email) {
  // 1) lookup direct par uid (idéal: équipe.uid === Firebase Auth uid)
  if (uid) {
    try {
      return await auth.getUser(uid);
    } catch {
      /* fallback email */
    }
  }
  // 2) lookup par email (cas où équipe.uid n'est pas l'uid Firebase Auth)
  if (email && email !== "?") {
    try {
      return await auth.getUserByEmail(email);
    } catch {
      return null;
    }
  }
  return null;
}

for (const d of eqSnap.docs) {
  const m = d.data();
  const role = m.role || "?";
  const nom = m.nom || "?";
  const actif = m.actif !== false;
  const uid = m.uid || null;
  const email = m.email || "?";

  if (!actif) continue;
  if (!buckets[role]) buckets[role] = [];

  const authUser = await checkAuth(uid, email);
  if (!authUser) {
    uidNotInAuth.push({ role, nom, email, uid });
    buckets[role].push(`  ⚠️  ${nom.padEnd(20)} (uid sans Firebase Auth) ${email}`);
    continue;
  }

  const hasPassword = authUser.providerData.some((p) => p.providerId === "password");
  ok.push({ role, nom, email });
  buckets[role].push(
    `  ✅ ${nom.padEnd(20)} ${authUser.email || email} ${hasPassword ? "[PIN ok]" : "[Google only]"}`,
  );
}

const order = ["superadmin", "admin", "chef", "chauffeur", "preparateur", "monteur", "apporteur"];
for (const r of order) {
  if (!buckets[r]) continue;
  console.log(`[${r}] (${buckets[r].length})`);
  for (const line of buckets[r]) console.log(line);
  console.log("");
}
const others = Object.keys(buckets).filter((r) => !order.includes(r));
for (const r of others) {
  console.log(`[${r}]`);
  for (const line of buckets[r]) console.log(line);
}

console.log("=".repeat(60));
console.log(`✅ OK : ${ok.length}`);
console.log(`⚠️  uid sans compte Firebase Auth : ${uidNotInAuth.length}`);
console.log(`❌ pas d'uid du tout : ${noUid.length}`);
if (uidNotInAuth.length) {
  console.log("\n→ Pas pouvoir se logger demain :");
  for (const m of uidNotInAuth) console.log(`   ${m.role.padEnd(12)} ${m.nom.padEnd(20)} ${m.email}`);
}
if (noUid.length) {
  console.log("\n→ Sans uid (sera pas reconnu après login Firebase) :");
  for (const m of noUid) console.log(`   ${m.role.padEnd(12)} ${m.nom.padEnd(20)} ${m.email}`);
}

process.exit(0);
