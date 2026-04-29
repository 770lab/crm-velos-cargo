/**
 * Audit + répare TOUS les comptes équipe :
 *   - Si pas d'user Auth pour le doc id → crée un user Auth (email synthétique
 *     si pas d'email côté doc)
 *   - Si user Auth existe mais email mismatch → met à jour l'email
 *   - Pose un password connu (vc-<DEFAULT_PIN>) si demandé
 *
 * Usage :
 *   node scripts/repair-all-equipe-auth.mjs --pin 1234       (répare + pose PIN 1234 partout)
 *   node scripts/repair-all-equipe-auth.mjs --pin 1234 --only nordine1,nordine2
 *   node scripts/repair-all-equipe-auth.mjs                  (audit dry-run, sans toucher)
 */
import admin from "firebase-admin";
admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: "velos-cargo" });
const db = admin.firestore();
const auth = admin.auth();

const args = process.argv.slice(2);
const pinIdx = args.indexOf("--pin");
const PIN = pinIdx >= 0 ? args[pinIdx + 1] : null;
const onlyIdx = args.indexOf("--only");
const ONLY = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(",").map((s) => s.trim().toLowerCase())) : null;
const APPLY = !!PIN;

function nameToEmail(nom) {
  const slug = String(nom)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (/^\d+[a-z]?$/.test(slug)) return `monteur-${slug}@velos-cargo.local`;
  return `${slug}@velos-cargo.local`;
}

const eqSnap = await db.collection("equipe").where("actif", "==", true).get();
const docs = eqSnap.docs.filter((d) => {
  const o = d.data();
  // Skip duplicates legacy : un doc apporteur dont l'email est aussi celui
  // d'un autre doc actif non-apporteur → c'est un duplicate (ex: Yoann
  // apporteur ET superadmin avec le même email). On garde le non-apporteur
  // pour ne pas écraser son password.
  if (o.role === "apporteur") {
    const email = (o.email || "").toLowerCase().trim();
    if (email) {
      const dup = eqSnap.docs.some((d2) =>
        d2.id !== d.id &&
        d2.data().actif !== false &&
        d2.data().role !== "apporteur" &&
        String(d2.data().email || "").toLowerCase().trim() === email,
      );
      if (dup) return false;
    }
  }
  if (!ONLY) return true;
  const nom = String(o.nom || "").toLowerCase();
  return ONLY.has(nom);
});

console.log(`Mode : ${APPLY ? "APPLY (PIN " + PIN + ")" : "DRY-RUN"} · ${docs.length} membres à auditer\n`);

let okCount = 0, createdCount = 0, updatedCount = 0, errCount = 0;
for (const d of docs) {
  const o = d.data();
  const nom = String(o.nom || "").trim();
  let email = (o.email || "").trim().toLowerCase();
  if (!email) email = nameToEmail(nom);
  let action = "ok";
  let warning = null;
  try {
    const u = await auth.getUser(d.id);
    // Update si email mismatch ou si on pose un PIN
    if (APPLY && (u.email !== email || PIN)) {
      await auth.updateUser(d.id, {
        email,
        displayName: nom,
        password: `vc-${PIN}`,
        disabled: false,
      });
      action = "updated";
      updatedCount++;
    } else {
      okCount++;
    }
  } catch (e) {
    if (e.code !== "auth/user-not-found") {
      console.log(`  ❌ ${nom} (${d.id}) — ${e.code} ${e.message}`);
      errCount++;
      continue;
    }
    if (!APPLY) {
      console.log(`  ⚠️  ${nom} (${d.id}) — PAS D'AUTH (créera avec email ${email})`);
      continue;
    }
    try {
      await auth.createUser({
        uid: d.id,
        email,
        displayName: nom,
        password: `vc-${PIN}`,
      });
      action = "created";
      createdCount++;
    } catch (e2) {
      if (e2.code === "auth/email-already-exists") {
        // Cet email est pris par un autre user Auth → mismatch profond,
        // on prend cet user et on update son password.
        try {
          const ex = await auth.getUserByEmail(email);
          await auth.updateUser(ex.uid, { password: `vc-${PIN}`, disabled: false });
          await db.collection("equipe").doc(d.id).update({ authUid: ex.uid });
          action = "linked_by_email";
          warning = `uid mismatch: doc=${d.id} auth=${ex.uid}`;
          updatedCount++;
        } catch (e3) {
          console.log(`  ❌ ${nom} (${d.id}) — ${e3.code}`);
          errCount++;
          continue;
        }
      } else {
        console.log(`  ❌ ${nom} (${d.id}) — ${e2.code} ${e2.message}`);
        errCount++;
        continue;
      }
    }
    // Met à jour le doc équipe avec l'email synthétique généré (pour cohérence)
    if (!o.email) {
      await d.ref.update({ email });
    }
  }
  console.log(`  ${action.padEnd(16)} · ${nom.padEnd(20)} email=${email}${warning ? " · " + warning : ""}`);
}

console.log(`\n${okCount} OK · ${createdCount} créés · ${updatedCount} maj · ${errCount} erreurs`);
if (APPLY) {
  console.log(`\nTous les comptes traités peuvent maintenant se connecter avec PIN ${PIN}.`);
}
