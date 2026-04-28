/**
 * Implémentations Firestore des actions historiquement servies par GAS.
 *
 * Ces fonctions sont appelées par `gas.ts` quand `NEXT_PUBLIC_USE_FIREBASE=1`,
 * pour que les pages existantes continuent d'appeler `gasPost(...)` /
 * `gasUpload(...)` sans modification.
 *
 * Format de retour : on imite la forme `{ ok: true, ... }` de GAS pour ne pas
 * casser les call-sites qui testent `r.ok`.
 *
 * Actions non migrées (Gemini / Drive / API externes) → renvoient
 * `{ ok: false, fallback: "gas" }` et `gas.ts` retombe sur un appel GAS réel.
 */

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  collection,
  serverTimestamp,
  writeBatch,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  Timestamp,
  type FieldValue,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { getFunctions, httpsCallable } from "firebase/functions";
import { db, firebaseApp, storage } from "./firebase";

const functions = getFunctions(firebaseApp, "europe-west1");

const ts = serverTimestamp;

// -------- helpers --------

type Body = Record<string, unknown>;

function getString(b: Body, key: string): string | undefined {
  const v = b[key];
  return typeof v === "string" ? v : undefined;
}

function getRequired(b: Body, key: string): string {
  const v = getString(b, key);
  if (!v) throw new Error(`Champ manquant: ${key}`);
  return v;
}

/**
 * Convertit une valeur "à la GAS" (string ISO ou ts ms) en Timestamp Firestore,
 * ou laisse passer une string non-date.
 */
function maybeDate(v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (!v) return null;
  // ISO date string ?
  const d = new Date(v);
  if (!Number.isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    return Timestamp.fromDate(d);
  }
  return v;
}

function applyMaybeDates(data: Body): Body & { updatedAt: FieldValue } {
  const out: Body = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === "datePrevue" || k === "dateEffective") {
      out[k] = maybeDate(v);
    } else {
      out[k] = v;
    }
  }
  return { ...out, updatedAt: ts() };
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; mime: string } {
  // Soit "data:image/jpeg;base64,XXX" soit raw base64
  let base64: string;
  let mime = "application/octet-stream";
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (m) {
    mime = m[1];
    base64 = m[2];
  } else {
    base64 = dataUrl;
  }
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { blob: new Blob([bytes], { type: mime }), mime };
}

async function uploadDataUrl(path: string, dataUrl: string, mimeOverride?: string) {
  const { blob, mime } = dataUrlToBlob(dataUrl);
  const r = ref(storage, path);
  await uploadBytes(r, blob, { contentType: mimeOverride || mime });
  return getDownloadURL(r);
}

// -------- catalog --------

export const FIRESTORE_ACTIONS = new Set<string>([
  // login
  "loginEquipe",
  // clients
  "createClient",
  "updateClient",
  "bulkUpdateClients",
  "setClientVelosTarget",
  // livraisons
  "createLivraison",
  "updateLivraison",
  // tournees → livraisons (ils sont stockés ensemble dans GAS)
  "createTournee",
  "createTournees",
  "assignTournee",
  // velos
  "setVeloFnuci",
  "assignFnuciToClient",
  "updateVelos",
  "markVeloLivre",
  "markVeloPrepare",
  "markVeloCharge",
  "markVeloLivreScan",
  "markClientAsDelivered",
  "unmarkVeloEtape",
  "unsetVeloClient",
  // équipe
  "upsertMembre",
  "setMembreCode",
  "clearMembreCode",
  // verifications
  "validateVerification",
  "rejectVerification",
  // uploads
  "uploadDoc",
  "uploadBlSignedPhoto",
  "uploadMontagePhoto",
  "uploadVeloPhoto",
  // sync admin
  "syncBonsNow",
]);

export function isMigrated(action: string): boolean {
  return FIRESTORE_ACTIONS.has(action);
}

// -------- dispatch --------

export async function runFirestoreAction(
  action: string,
  body: Body,
): Promise<unknown> {
  switch (action) {
    // ---------- login ----------
    case "loginEquipe": {
      // Par sécurité on n'autorise PAS le login PIN via cette voie : la nouvelle
      // auth Firebase passe par auth-gate-firebase (signInWithEmailAndPassword).
      // Si l'ancien auth-gate.tsx est encore actif, on renvoie une erreur claire.
      return { ok: false, error: "Auth GAS désactivée — utilise auth-gate-firebase" };
    }

    // ---------- clients ----------
    case "createClient": {
      // apporteurLower : champ dénormalisé case-insensitive pour le RBAC
      // apporteur (cf. firestore.rules + scripts/backfill-apporteur-lower.mjs).
      const apporteurLower = body.apporteur
        ? String(body.apporteur).trim().toLowerCase() || null
        : null;
      const ref = await addDoc(collection(db, "clients"), {
        ...body,
        nbVelosCommandes: Number(body.nbVelosCommandes) || 0,
        apporteurLower,
        createdAt: ts(),
        updatedAt: ts(),
      });
      return { ok: true, id: ref.id };
    }

    case "updateClient": {
      const id = getRequired(body, "id");
      const data = (body.data as Body) || {};
      // Le système GAS accepte des updates "à plat" ({ kbisRecu: true, kbisLien: "..." }).
      // Les docs Firestore sont structurés (docs.kbisRecu, docLinks.kbis).
      // On reroute proprement.
      const updates: Body = { updatedAt: ts() };
      const docFlags = [
        "devisSignee",
        "kbisRecu",
        "attestationRecue",
        "signatureOk",
        "inscriptionBicycle",
        "parcelleCadastrale",
      ];
      const docLinkMap: Record<string, string> = {
        devisLien: "docLinks.devis",
        kbisLien: "docLinks.kbis",
        attestationLien: "docLinks.attestation",
        signatureLien: "docLinks.signature",
        bicycleLien: "docLinks.bicycle",
        parcelleCadastraleLien: "docLinks.parcelleCadastrale",
      };
      const docDateMap: Record<string, string> = {
        kbisDate: "docDates.kbis",
        dateEngagement: "docDates.engagement",
        liasseFiscaleDate: "docDates.liasseFiscale",
      };
      for (const [k, v] of Object.entries(data)) {
        if (docFlags.includes(k)) updates[`docs.${k}`] = !!v;
        else if (docLinkMap[k]) updates[docLinkMap[k]] = v;
        else if (docDateMap[k]) updates[docDateMap[k]] = v;
        else updates[k] = v;
      }
      // Si apporteur change, on met à jour aussi apporteurLower (RBAC).
      if ("apporteur" in data) {
        updates.apporteurLower = data.apporteur
          ? String(data.apporteur).trim().toLowerCase() || null
          : null;
      }
      await updateDoc(doc(db, "clients", id), updates);
      return { ok: true };
    }

    case "bulkUpdateClients": {
      const ids = (body.clientIds as string[]) || [];
      const data = (body.data as Body) || {};
      const batch = writeBatch(db);
      for (const id of ids) {
        batch.update(doc(db, "clients", id), { ...data, updatedAt: ts() });
      }
      await batch.commit();
      return { ok: true, updated: ids.length };
    }

    case "setClientVelosTarget": {
      const clientId = getRequired(body, "clientId");
      const target = Number(body.target) || 0;
      await updateDoc(doc(db, "clients", clientId), {
        nbVelosCommandes: target,
        updatedAt: ts(),
      });
      return { ok: true };
    }

    // ---------- livraisons ----------
    case "createLivraison": {
      // tourneeNumero stable : si le tourneeId est déjà connu, on hérite du
      // numéro existant (mêmes tournées = même numéro). Sinon on alloue
      // max(tourneeNumero) + 1 (numérotation globale qui ne décrémente jamais
      // même quand on annule une tournée intermédiaire — cf. ce que demande
      // Yoann le 2026-04-28).
      const tourneeId = getString(body, "tourneeId");
      let tourneeNumero: number | undefined;
      if (tourneeId) {
        const sib = await getDocs(
          query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
        );
        for (const d of sib.docs) {
          const n = (d.data() as { tourneeNumero?: number }).tourneeNumero;
          if (typeof n === "number") { tourneeNumero = n; break; }
        }
      }
      if (tourneeNumero == null) {
        // Nouvelle tournée → max + 1. On utilise orderBy desc + limit 1 pour
        // ne lire QU'UN seul doc Firestore (avant : full scan de la collection
        // livraisons à chaque création de tournée — coût croissant à mesure que
        // la base grandit).
        const top = await getDocs(
          query(collection(db, "livraisons"), orderBy("tourneeNumero", "desc"), limit(1)),
        );
        let maxN = 0;
        if (!top.empty) {
          const n = (top.docs[0].data() as { tourneeNumero?: number }).tourneeNumero;
          if (typeof n === "number") maxN = n;
        }
        tourneeNumero = maxN + 1;
      }
      // apporteurLower : dénormalisé depuis le client pour le RBAC apporteur
      // (cf. firestore.rules + scripts/backfill-apporteur-lower.mjs).
      let apporteurLowerLiv: string | null = null;
      const cidLiv = getString(body, "clientId");
      if (cidLiv) {
        try {
          const cSnap = await getDoc(doc(db, "clients", cidLiv));
          if (cSnap.exists()) {
            const cData = cSnap.data() as { apporteur?: string; apporteurLower?: string };
            apporteurLowerLiv = cData.apporteurLower
              || (cData.apporteur ? String(cData.apporteur).trim().toLowerCase() : null)
              || null;
          }
        } catch {}
      }
      const ref = await addDoc(collection(db, "livraisons"), {
        ...applyMaybeDates(body),
        tourneeNumero,
        apporteurLower: apporteurLowerLiv,
        statut: body.statut || "planifiee",
        createdAt: ts(),
      });
      return { ok: true, id: ref.id, tourneeNumero };
    }

    case "updateLivraison": {
      const id = getRequired(body, "id");
      const data = (body.data as Body) || {};
      await updateDoc(doc(db, "livraisons", id), applyMaybeDates(data));
      return { ok: true };
    }

    // ---------- tournees ----------
    case "createTournee": {
      const ref = await addDoc(collection(db, "tournees"), {
        ...applyMaybeDates(body),
        statut: body.statut || "planifiee",
        createdAt: ts(),
      });
      return { ok: true, id: ref.id };
    }

    case "createTournees": {
      const tournees = (body.tournees as Body[]) || [];
      const batch = writeBatch(db);
      const ids: string[] = [];
      for (const t of tournees) {
        const ref = doc(collection(db, "tournees"));
        ids.push(ref.id);
        batch.set(ref, {
          ...applyMaybeDates(t),
          statut: t.statut || "planifiee",
          createdAt: ts(),
        });
      }
      await batch.commit();
      return { ok: true, ids };
    }

    case "assignTournee": {
      // 2 modes d'appel :
      //  - livraisonId/id : MAJ d'UNE livraison ciblée (rare, non utilisé par
      //    l'UI Affectation équipe actuelle).
      //  - tourneeId      : MAJ de TOUTES les livraisons d'une tournée d'un
      //    coup. C'est ce que fait le panel "Affectation équipe" du planning
      //    semaine — on n'a qu'une équipe par tournée, pas par client.
      // L'ancienne version ne gérait que livraisonId → l'UI plantait avec
      // "livraisonId requis" car elle envoie tourneeId.
      const livraisonId = getString(body, "livraisonId") || getString(body, "id");
      const tourneeId = getString(body, "tourneeId");
      const writableKeys = [
        "chauffeurId",
        "chefEquipeId",
        "chefEquipeIds",
        "monteurIds",
        "preparateurIds",
        "mode",
      ];
      const fields: Body = { updatedAt: ts() };
      for (const k of writableKeys) {
        if (k in body) fields[k] = body[k];
      }
      if (livraisonId) {
        // Ciblage 1 livraison : on autorise aussi à changer son tourneeId
        // (cas marginal, rebascule).
        if ("tourneeId" in body) fields.tourneeId = body.tourneeId;
        await updateDoc(doc(db, "livraisons", livraisonId), fields);
        return { ok: true, updated: 1 };
      }
      if (tourneeId) {
        const snap = await getDocs(
          query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
        );
        if (snap.empty) return { ok: true, updated: 0 };
        const batch = writeBatch(db);
        for (const d of snap.docs) batch.update(d.ref, fields);
        await batch.commit();
        return { ok: true, updated: snap.size };
      }
      throw new Error("livraisonId ou tourneeId requis");
    }

    // ---------- velos ----------
    case "setVeloFnuci": {
      const veloId = getRequired(body, "veloId");
      const fnuci = getString(body, "fnuci") || null;
      await updateDoc(doc(db, "velos", veloId), { fnuci, updatedAt: ts() });
      return { ok: true };
    }

    case "assignFnuciToClient": {
      // Trouve un vélo du client sans FNUCI et lui assigne.
      const clientId = getRequired(body, "clientId");
      const fnuci = getRequired(body, "fnuci");
      const q = query(
        collection(db, "velos"),
        where("clientId", "==", clientId),
        where("fnuci", "==", null),
      );
      const snap = await getDocs(q);
      if (snap.empty) {
        return { ok: false, error: "Tous les vélos de ce client ont déjà un FNUCI" };
      }
      const veloDoc = snap.docs[0];
      await updateDoc(veloDoc.ref, {
        fnuci,
        datePreparation: ts(),
        updatedAt: ts(),
      });
      return { ok: true, veloId: veloDoc.id };
    }

    case "updateVelos": {
      const veloIds = (body.veloIds as string[]) || [];
      const action = getString(body, "bulkAction");
      if (!action) throw new Error("bulkAction requis");
      const updates: Body = { updatedAt: ts() };
      switch (action) {
        case "markFacturable":
          updates.facturable = true;
          break;
        case "unmarkFacturable":
          updates.facturable = false;
          break;
        case "markFacture":
          updates.facture = true;
          break;
        case "unmarkFacture":
          updates.facture = false;
          break;
        case "markCertificat":
          updates.certificatRecu = true;
          break;
        default:
          updates[action] = true; // best-effort
      }
      const batch = writeBatch(db);
      for (const id of veloIds) batch.update(doc(db, "velos", id), updates);
      await batch.commit();
      return { ok: true, updated: veloIds.length };
    }

    case "markVeloLivre": {
      const veloId = getRequired(body, "veloId");
      await updateDoc(doc(db, "velos", veloId), {
        dateLivraisonScan: ts(),
        updatedAt: ts(),
      });
      return { ok: true };
    }

    case "markVeloPrepare":
    case "markVeloCharge":
    case "markVeloLivreScan": {
      // Scan QR BicyCode (ou saisie manuelle) → on marque l'étape pour le vélo
      // qui porte ce FNUCI. Validation : le vélo doit appartenir à un client de
      // la tournée, sinon HORS_TOURNEE. Si aucun vélo n'a ce FNUCI → FNUCI_INCONNU
      // (ce qui déclenche le mode fusion réception+prép côté UI en mode prep).
      const fnuci = getRequired(body, "fnuci").toUpperCase();
      const tourneeId = getRequired(body, "tourneeId");
      const userId = getString(body, "userId");

      const stageMap = {
        markVeloPrepare: { dateField: "datePreparation", userField: "preparateurId" },
        markVeloCharge: { dateField: "dateChargement", userField: "chargeurId" },
        markVeloLivreScan: { dateField: "dateLivraisonScan", userField: "livreurId" },
      } as const;
      const stage = stageMap[action as keyof typeof stageMap];

      // 1. Trouve le vélo via FNUCI
      const vSnap = await getDocs(
        query(collection(db, "velos"), where("fnuci", "==", fnuci)),
      );
      if (vSnap.empty) {
        return { error: "FNUCI inconnu", code: "FNUCI_INCONNU", fnuci };
      }
      const veloDoc = vSnap.docs[0];
      const velo = veloDoc.data() as {
        clientId?: string;
        datePreparation?: unknown;
        dateChargement?: unknown;
        dateLivraisonScan?: unknown;
      };
      const veloClientId = velo.clientId;
      if (!veloClientId) {
        return { error: "Vélo non affilié à un client", code: "FNUCI_INCONNU", fnuci };
      }

      // 2. Le client doit être dans la tournée
      const livSnap = await getDocs(
        query(
          collection(db, "livraisons"),
          where("tourneeId", "==", tourneeId),
          where("clientId", "==", veloClientId),
        ),
      );
      if (livSnap.empty) {
        // Récupère le nom du client pour le message d'erreur
        let veloClientName: string | null = null;
        try {
          const c = await getDoc(doc(db, "clients", veloClientId));
          if (c.exists()) {
            veloClientName = (c.data() as { entreprise?: string }).entreprise || null;
          }
        } catch {}
        return {
          error: "Pas dans cette tournée",
          code: "HORS_TOURNEE",
          fnuci,
          veloClientId,
          veloClientName,
        };
      }
      const livraisonClientName = (livSnap.docs[0].data() as {
        clientSnapshot?: { entreprise?: string };
      }).clientSnapshot?.entreprise || null;

      // 3. Étape déjà faite → renvoie ok + alreadyDone
      const dateExisting = velo[stage.dateField as keyof typeof velo];
      if (dateExisting) {
        return {
          ok: true,
          alreadyDone: true,
          etape: stage.dateField,
          veloId: veloDoc.id,
          fnuci,
          clientId: veloClientId,
          clientName: livraisonClientName,
          date: (dateExisting as { toDate?: () => Date })?.toDate?.()?.toISOString() || null,
        };
      }

      // 4. Marque l'étape
      const updates: Body = {
        [stage.dateField]: ts(),
        updatedAt: ts(),
      };
      if (userId) updates[stage.userField] = userId;
      await updateDoc(veloDoc.ref, updates);
      return {
        ok: true,
        alreadyDone: false,
        etape: stage.dateField,
        veloId: veloDoc.id,
        fnuci,
        clientId: veloClientId,
        clientName: livraisonClientName,
        date: new Date().toISOString(),
      };
    }

    case "markClientAsDelivered": {
      // Marque toutes les livraisons "en_cours" du client comme livrées.
      const clientId = getRequired(body, "clientId");
      const tourneeId = getString(body, "tourneeId");
      const q = tourneeId
        ? query(
            collection(db, "livraisons"),
            where("clientId", "==", clientId),
            where("tourneeId", "==", tourneeId),
          )
        : query(collection(db, "livraisons"), where("clientId", "==", clientId));
      const snap = await getDocs(q);
      const batch = writeBatch(db);
      let n = 0;
      for (const d of snap.docs) {
        batch.update(d.ref, {
          statut: "livree",
          dateEffective: ts(),
          updatedAt: ts(),
        });
        n++;
      }
      await batch.commit();
      return { ok: true, updated: n };
    }

    case "unmarkVeloEtape": {
      const veloId = getRequired(body, "veloId");
      const etape = getRequired(body, "etape");
      const fieldMap: Record<string, string> = {
        preparation: "datePreparation",
        chargement: "dateChargement",
        livraison: "dateLivraisonScan",
        montage: "dateMontage",
      };
      const field = fieldMap[etape];
      if (!field) return { ok: false, error: `étape inconnue: ${etape}` };
      await updateDoc(doc(db, "velos", veloId), {
        [field]: null,
        updatedAt: ts(),
      });
      return { ok: true };
    }

    case "unsetVeloClient": {
      const veloId = getRequired(body, "veloId");
      await updateDoc(doc(db, "velos", veloId), {
        clientId: null,
        fnuci: null,
        datePreparation: null,
        updatedAt: ts(),
      });
      return { ok: true };
    }

    // ---------- équipe ----------
    case "upsertMembre": {
      const id = getString(body, "id");
      const data: Body = {
        nom: body.nom,
        role: body.role,
        telephone: body.telephone || null,
        email: body.email || null,
        actif: body.actif !== false,
        notes: body.notes || null,
        salaireJournalier: body.salaireJournalier ?? null,
        primeVelo: body.primeVelo ?? null,
        updatedAt: ts(),
      };
      if (id) {
        await setDoc(doc(db, "equipe", id), data, { merge: true });
        return { ok: true, id };
      } else {
        // Nouveau membre sans Auth (on n'a pas de mot de passe ici).
        // Le doc est créé avec un id Firestore aléatoire, le compte Auth peut
        // être ajouté plus tard via un script seed-admin.
        const ref = await addDoc(collection(db, "equipe"), {
          ...data,
          createdAt: ts(),
        });
        return { ok: true, id: ref.id };
      }
    }

    case "setMembreCode": {
      // Délègue à la Cloud Function callable (admin SDK requise pour modifier
      // le mot de passe Firebase Auth d'un autre user).
      const callable = httpsCallable<
        { id: string; pin?: string | null },
        { ok: boolean; error?: string }
      >(functions, "setMembreCode");
      try {
        const r = await callable({
          id: getRequired(body, "id"),
          pin: getString(body, "pin") ?? null,
        });
        return r.data;
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    case "clearMembreCode": {
      const callable = httpsCallable<
        { id: string },
        { ok: boolean; error?: string }
      >(functions, "clearMembreCode");
      try {
        const r = await callable({ id: getRequired(body, "id") });
        return r.data;
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    // ---------- verifications ----------
    case "validateVerification": {
      const id = getRequired(body, "id");
      await updateDoc(doc(db, "verifications", id), {
        status: "validated",
        reviewedAt: ts(),
      });
      return { ok: true };
    }

    case "rejectVerification": {
      const id = getRequired(body, "id");
      await updateDoc(doc(db, "verifications", id), {
        status: "rejected",
        reviewedAt: ts(),
        notes: body.notes || null,
      });
      return { ok: true };
    }

    // ---------- uploads (Storage) ----------
    case "uploadDoc": {
      const clientId = getRequired(body, "clientId");
      const docType = getRequired(body, "docType");
      const fileData = getRequired(body, "fileData");
      const fileName = getString(body, "fileName") || `${docType}-${Date.now()}`;
      const url = await uploadDataUrl(
        `clients/${clientId}/documents/${fileName}`,
        fileData,
      );
      const linkField: Record<string, string> = {
        devis: "docLinks.devis",
        kbis: "docLinks.kbis",
        attestation: "docLinks.attestation",
        signature: "docLinks.signature",
        bicycle: "docLinks.bicycle",
        parcelleCadastrale: "docLinks.parcelleCadastrale",
      };
      const flagField: Record<string, string> = {
        devis: "docs.devisSignee",
        kbis: "docs.kbisRecu",
        attestation: "docs.attestationRecue",
        signature: "docs.signatureOk",
        bicycle: "docs.inscriptionBicycle",
        parcelleCadastrale: "docs.parcelleCadastrale",
      };
      const updates: Body = { updatedAt: ts() };
      if (linkField[docType]) updates[linkField[docType]] = url;
      if (flagField[docType]) updates[flagField[docType]] = true;
      await updateDoc(doc(db, "clients", clientId), updates);
      return { ok: true, url };
    }

    case "uploadBlSignedPhoto": {
      // Le composant BlSignedUploader n'a pas livraisonId sous la main, juste
      // tourneeId + clientId. On résout côté serveur (parité avec GAS).
      const tourneeId = getRequired(body, "tourneeId");
      const clientId = getRequired(body, "clientId");
      const photoData = getRequired(body, "photoData");
      const snap = await getDocs(
        query(
          collection(db, "livraisons"),
          where("tourneeId", "==", tourneeId),
          where("clientId", "==", clientId),
        ),
      );
      if (snap.empty) {
        return { error: "Aucune livraison trouvée pour ce client/tournée" };
      }
      const livraisonId = snap.docs[0].id;
      const fileName = `bl-signed-${Date.now()}.jpg`;
      const url = await uploadDataUrl(
        `bl/${livraisonId}/${fileName}`,
        photoData,
        "image/jpeg",
      );
      await updateDoc(doc(db, "livraisons", livraisonId), {
        urlBlSigne: url,
        updatedAt: ts(),
      });
      return { ok: true, livraisonId, clientId, tourneeId, photoUrl: url };
    }

    case "uploadMontagePhoto": {
      // Miroir fidèle de la fonction GAS uploadMontagePhoto : résout le vélo
      // par FNUCI, écrit la photo dans le bon slot (urlPhotoMontageEtiquette /
      // urlPhotoMontageQrVelo / photoMontageUrl), et ne pose dateMontage
      // QUE quand les 3 slots sont remplis (preuve complète du montage).
      const fnuci = getRequired(body, "fnuci").toUpperCase();
      const slot = getRequired(body, "slot");
      const photoData = getRequired(body, "photoData");
      const monteurId = getString(body, "monteurId");

      if (slot !== "etiquette" && slot !== "qrvelo" && slot !== "monte") {
        return { error: "slot invalide (attendu : etiquette, qrvelo, monte)" };
      }

      // 1. Résolution FNUCI → vélo
      const vSnap = await getDocs(
        query(collection(db, "velos"), where("fnuci", "==", fnuci)),
      );
      const matches = vSnap.docs.filter((d) => !(d.data() as { annule?: boolean }).annule);
      if (matches.length === 0) {
        return { error: "FNUCI inconnu — passe d'abord par la préparation", fnuci };
      }
      if (matches.length > 1) {
        return {
          error: `DOUBLON FNUCI : ce code est présent sur ${matches.length} vélos en base. Corrige la saisie avant d'uploader la photo.`,
          fnuci,
          doublons: matches.map((d) => ({
            veloId: d.id,
            clientId: (d.data() as { clientId?: string }).clientId || "",
          })),
        };
      }
      const veloDoc = matches[0];
      const velo = veloDoc.data() as {
        clientId?: string;
        urlPhotoMontageEtiquette?: string;
        urlPhotoMontageQrVelo?: string;
        photoMontageUrl?: string;
        dateMontage?: { toDate?: () => Date } | string;
      };
      const veloId = veloDoc.id;
      const clientId = velo.clientId || "no-client";

      // 2. Upload Storage
      const fileName = `${fnuci}_${slot}_${Date.now()}.jpg`;
      const url = await uploadDataUrl(
        `montage/${clientId}/${fileName}`,
        photoData,
        "image/jpeg",
      );

      // 3. Champ destination en miroir GAS (champs plats lus par le composant)
      const slotField =
        slot === "etiquette"
          ? "urlPhotoMontageEtiquette"
          : slot === "qrvelo"
            ? "urlPhotoMontageQrVelo"
            : "photoMontageUrl";

      const updates: Body = {
        [slotField]: url,
        updatedAt: ts(),
      };

      // 4. Les 3 slots remplis après cet upload ?
      const hasEtiquette = slot === "etiquette" || !!velo.urlPhotoMontageEtiquette;
      const hasQrVelo = slot === "qrvelo" || !!velo.urlPhotoMontageQrVelo;
      const hasMonte = slot === "monte" || !!velo.photoMontageUrl;
      const allThree = hasEtiquette && hasQrVelo && hasMonte;
      const alreadyMonte = !!velo.dateMontage;
      let dateMontageRet: string | null = null;
      if (allThree && !alreadyMonte) {
        updates.dateMontage = ts();
        if (monteurId) updates.monteParId = monteurId;
        dateMontageRet = new Date().toISOString();
      } else if (alreadyMonte) {
        const t = velo.dateMontage as { toDate?: () => Date } | string;
        dateMontageRet =
          typeof t === "string"
            ? t
            : t?.toDate?.()?.toISOString() || null;
      }

      await updateDoc(veloDoc.ref, updates);

      // 5. Nom du client pour message UX
      let clientName: string | null = null;
      try {
        const c = await getDoc(doc(db, "clients", clientId));
        if (c.exists()) {
          clientName = (c.data() as { entreprise?: string }).entreprise || null;
        }
      } catch {}

      return {
        ok: true,
        veloId,
        fnuci,
        clientId,
        clientName,
        slot,
        photoUrl: url,
        photos: { etiquette: hasEtiquette, qrvelo: hasQrVelo, monte: hasMonte },
        complete: allThree,
        dateMontage: dateMontageRet,
      };
    }

    case "uploadVeloPhoto": {
      const veloId = getRequired(body, "veloId");
      const stage = getString(body, "stage") || "qr";
      const photoData = getRequired(body, "photoData");
      const url = await uploadDataUrl(
        `preparation/${veloId}/${stage}-${Date.now()}.jpg`,
        photoData,
        "image/jpeg",
      );
      const fieldMap: Record<string, string> = {
        etiquette: "photos.montageEtiquette",
        qr: "photos.montageQrVelo",
      };
      const field = fieldMap[stage] || "photos.montageQrVelo";
      await updateDoc(doc(db, "velos", veloId), {
        [field]: url,
        photoQrPrise: stage === "qr" ? true : undefined,
        updatedAt: ts(),
      });
      return { ok: true, url };
    }

    case "syncBonsNow": {
      // Force la sync GAS → Firestore des bonsEnlevement + verifications
      // immédiatement (sans attendre le cron 15 min). Délègue à la Cloud
      // Function syncFromGasNow (réservée admins).
      const callable = httpsCallable<
        Record<string, never>,
        { ok: boolean; bons?: number; verifs?: number; error?: string }
      >(functions, "syncFromGasNow");
      try {
        const r = await callable({});
        return r.data;
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    default:
      return { ok: false, error: `Action Firestore non implémentée: ${action}` };
  }
}

// -------- read helpers (aussi utilisable depuis gas.ts) --------

/**
 * Quelques lectures qui pourraient appeler GAS aujourd'hui.
 * Pas exhaustif — on étend si besoin.
 */
export async function runFirestoreGet(
  action: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  switch (action) {
    case "getClient": {
      // Reproduit la shape GAS getClient (gas/Code.js:424) attendue par
      // /clients/detail : on aplatit docs.X / docLinks.X / docDates.X stockés
      // en sous-objets côté Firestore vers les champs flat (devisSignee,
      // devisLien, dateEngagement…) consommés par l'UI, et on hydrate
      // velos[] (avec photos montage + livraison rattachée + urlBlSigne).
      // Sans ce mapping la fiche client était vide post-migration.
      const id = params.id;
      if (!id) throw new Error("id requis");
      const snap = await getDoc(doc(db, "clients", id));
      if (!snap.exists()) return { error: "Client introuvable" };
      const c = snap.data() as Record<string, unknown>;

      const isoOrNull = (x: unknown): string | null => {
        if (!x) return null;
        if (x instanceof Date) return x.toISOString();
        const t = x as { toDate?: () => Date };
        if (t?.toDate) return t.toDate().toISOString();
        const s = String(x).trim();
        return s || null;
      };
      const asUrl = (x: unknown): string | null => {
        const s = String(x || "").trim();
        return s || null;
      };

      const docs = (c.docs as Record<string, unknown>) || {};
      const docLinks = (c.docLinks as Record<string, unknown>) || {};
      const docDates = (c.docDates as Record<string, unknown>) || {};
      // ?? privilégie l'éventuel champ flat hérité (ancienne shape GAS) sinon
      // tombe sur le sous-objet Firestore actuel.
      const flat = {
        devisSignee: (c.devisSignee as boolean) ?? !!docs.devisSignee,
        kbisRecu: (c.kbisRecu as boolean) ?? !!docs.kbisRecu,
        attestationRecue: (c.attestationRecue as boolean) ?? !!docs.attestationRecue,
        signatureOk: (c.signatureOk as boolean) ?? !!docs.signatureOk,
        inscriptionBicycle: (c.inscriptionBicycle as boolean) ?? !!docs.inscriptionBicycle,
        parcelleCadastrale: (c.parcelleCadastrale as boolean) ?? !!docs.parcelleCadastrale,
        effectifMentionne: (c.effectifMentionne as boolean) ?? !!docs.effectifMentionne,
        devisLien: (c.devisLien as string | null) ?? (docLinks.devis as string | null) ?? null,
        kbisLien: (c.kbisLien as string | null) ?? (docLinks.kbis as string | null) ?? null,
        attestationLien:
          (c.attestationLien as string | null) ?? (docLinks.attestation as string | null) ?? null,
        signatureLien:
          (c.signatureLien as string | null) ?? (docLinks.signature as string | null) ?? null,
        bicycleLien:
          (c.bicycleLien as string | null) ?? (docLinks.bicycle as string | null) ?? null,
        parcelleCadastraleLien:
          (c.parcelleCadastraleLien as string | null) ??
          (docLinks.parcelleCadastrale as string | null) ??
          null,
        kbisDate: (c.kbisDate as string | null) ?? (docDates.kbis as string | null) ?? null,
        dateEngagement:
          (c.dateEngagement as string | null) ?? (docDates.engagement as string | null) ?? null,
        liasseFiscaleDate:
          (c.liasseFiscaleDate as string | null) ??
          (docDates.liasseFiscale as string | null) ??
          null,
      };

      // Livraisons indexées par tourneeId pour rattacher chaque vélo à SA
      // livraison (et son urlBlSigne). Multi-tournées : on rattache via
      // tourneeIdScan ; mono-tournée : fallback sur la seule livraison.
      const livSnap = await getDocs(
        query(collection(db, "livraisons"), where("clientId", "==", id)),
      );
      type Liv = {
        id: string;
        tourneeId: string;
        statut: string;
        datePrevue: string | null;
        dateEffective: string | null;
        urlBlSigne: string | null;
      };
      const livraisonsByTournee: Record<string, Liv> = {};
      for (const ld of livSnap.docs) {
        const l = ld.data() as Record<string, unknown>;
        const tId = String(l.tourneeId || "");
        livraisonsByTournee[tId] = {
          id: ld.id,
          tourneeId: tId,
          statut: String(l.statut || "planifiee"),
          datePrevue: isoOrNull(l.datePrevue),
          dateEffective: isoOrNull(l.dateEffective),
          urlBlSigne: asUrl(l.urlBlSigne),
        };
      }
      const livKeys = Object.keys(livraisonsByTournee);

      const vSnap = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", id)),
      );
      const velos = vSnap.docs
        .filter((d) => !(d.data() as { annule?: boolean }).annule)
        .map((d) => {
          const v = d.data() as Record<string, unknown>;
          const fnuci = String(v.fnuci || "").trim() || null;
          const urlEtiquette = asUrl(v.urlPhotoMontageEtiquette);
          const urlQrVelo = asUrl(v.urlPhotoMontageQrVelo);
          const urlMonte = asUrl(v.photoMontageUrl);
          const hasDateMontage = !!v.dateMontage;
          const hasDateLivScan = !!v.dateLivraisonScan;

          // tourneeIdScan d'abord (champ historique GAS), puis tourneeId si
          // posé par le scan livraison côté Firestore. Sinon fallback "1 seule
          // livraison" pour les clients mono-tournée (cas le plus courant).
          const tournId = String(v.tourneeIdScan || v.tourneeId || "").trim();
          let liv: Liv | null = null;
          if (tournId && livraisonsByTournee[tournId]) liv = livraisonsByTournee[tournId];
          else if (livKeys.length === 1) liv = livraisonsByTournee[livKeys[0]];

          return {
            id: d.id,
            reference: fnuci,
            qrCode: fnuci,
            certificatRecu: !!v.certificatRecu || !!fnuci,
            certificatNumero: (v.certificatNumero as string | null) || null,
            photoQrPrise: !!v.photoQrPrise || !!urlQrVelo || hasDateMontage,
            facturable: !!v.facturable,
            facture: !!v.facture,
            monte: hasDateMontage,
            livre: hasDateLivScan,
            urlPhotoMontageEtiquette: urlEtiquette,
            urlPhotoMontageQrVelo: urlQrVelo,
            photoMontageUrl: urlMonte,
            livraison: liv,
            urlBlSigne: liv ? liv.urlBlSigne : null,
            livraisonOrpheline: !liv && livKeys.length > 0,
          };
        });

      return { id: snap.id, ...c, ...flat, velos };
    }
    case "getTourneeProgression": {
      const tourneeId = params.tourneeId;
      if (!tourneeId) throw new Error("tourneeId requis");
      const livSnap = await getDocs(
        query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
      );
      // datePrevue de la tournée = celle de n'importe quelle livraison (toutes égales)
      let datePrevue: string | null = null;
      // ordre : on garde l'ordre du Firestore (= ordre arrêt) — affinage possible plus tard
      const clientOrder: string[] = [];
      const clientInfo: Record<
        string,
        { clientId: string; entreprise: string; ville: string; adresse: string; codePostal: string }
      > = {};
      for (const d of livSnap.docs) {
        const l = d.data() as {
          clientId?: string;
          datePrevue?: { toDate?: () => Date };
          clientSnapshot?: {
            entreprise?: string;
            ville?: string;
            adresse?: string;
            codePostal?: string;
          };
        };
        const cid = l.clientId;
        if (!cid) continue;
        if (!datePrevue && l.datePrevue?.toDate) {
          datePrevue = l.datePrevue.toDate().toISOString();
        }
        if (!clientInfo[cid]) {
          clientOrder.push(cid);
          clientInfo[cid] = {
            clientId: cid,
            entreprise: l.clientSnapshot?.entreprise || "",
            ville: l.clientSnapshot?.ville || "",
            adresse: l.clientSnapshot?.adresse || "",
            codePostal: l.clientSnapshot?.codePostal || "",
          };
        }
      }

      type Velo = {
        veloId: string;
        fnuci: string | null;
        datePreparation: string | null;
        dateChargement: string | null;
        dateLivraisonScan: string | null;
        dateMontage: string | null;
      };
      const velosByClient: Record<string, Velo[]> = {};
      const totals = { total: 0, prepare: 0, charge: 0, livre: 0, monte: 0 };
      const perClientTotals: Record<
        string,
        { total: number; prepare: number; charge: number; livre: number; monte: number }
      > = {};
      const isoOrNull = (x: unknown): string | null => {
        if (!x) return null;
        const t = x as { toDate?: () => Date };
        return t?.toDate ? t.toDate().toISOString() : null;
      };
      const chunks: string[][] = [];
      for (let i = 0; i < clientOrder.length; i += 30) {
        chunks.push(clientOrder.slice(i, i + 30));
      }
      for (const chunk of chunks) {
        if (!chunk.length) continue;
        const vSnap = await getDocs(
          query(collection(db, "velos"), where("clientId", "in", chunk)),
        );
        for (const d of vSnap.docs) {
          const data = d.data() as {
            clientId?: string;
            fnuci?: string | null;
            datePreparation?: unknown;
            dateChargement?: unknown;
            dateLivraisonScan?: unknown;
            dateMontage?: unknown;
          };
          const cid = data.clientId || "";
          if (!cid) continue;
          if (!velosByClient[cid]) velosByClient[cid] = [];
          if (!perClientTotals[cid]) {
            perClientTotals[cid] = { total: 0, prepare: 0, charge: 0, livre: 0, monte: 0 };
          }
          const v: Velo = {
            veloId: d.id,
            fnuci: data.fnuci || null,
            datePreparation: isoOrNull(data.datePreparation),
            dateChargement: isoOrNull(data.dateChargement),
            dateLivraisonScan: isoOrNull(data.dateLivraisonScan),
            dateMontage: isoOrNull(data.dateMontage),
          };
          velosByClient[cid].push(v);
          perClientTotals[cid].total++;
          totals.total++;
          if (v.datePreparation) {
            perClientTotals[cid].prepare++;
            totals.prepare++;
          }
          if (v.dateChargement) {
            perClientTotals[cid].charge++;
            totals.charge++;
          }
          if (v.dateLivraisonScan) {
            perClientTotals[cid].livre++;
            totals.livre++;
          }
          if (v.dateMontage) {
            perClientTotals[cid].monte++;
            totals.monte++;
          }
        }
      }

      const clients = clientOrder.map((cid) => ({
        ...clientInfo[cid],
        velos: velosByClient[cid] || [],
        totals: perClientTotals[cid] || {
          total: 0,
          prepare: 0,
          charge: 0,
          livre: 0,
          monte: 0,
        },
      }));
      return { tourneeId, datePrevue, totals, clients };
    }
    case "getClientPreparation": {
      // Miroir GAS getClientPreparation : utilisé par /montage pour afficher
      // les vélos d'un client avec leur état (3 slots photo + dateMontage).
      // Source de vérité = collection `velos` Firestore (où markVeloPrepare/
      // Charge/LivreScan + uploadMontagePhoto écrivent).
      const clientId = params.clientId;
      if (!clientId) return { error: "clientId requis" };
      const cSnap = await getDoc(doc(db, "clients", clientId));
      if (!cSnap.exists()) return { error: "Client introuvable" };
      const c = cSnap.data() as { entreprise?: string; adresse?: string; ville?: string };
      const vSnap = await getDocs(
        query(collection(db, "velos"), where("clientId", "==", clientId)),
      );
      const isoOrNull = (x: unknown): string | null => {
        if (!x) return null;
        if (x instanceof Date) return x.toISOString();
        const t = x as { toDate?: () => Date };
        if (t?.toDate) return t.toDate().toISOString();
        const s = String(x).trim();
        return s || null;
      };
      const asUrl = (x: unknown): string | null => {
        const s = String(x || "").trim();
        return s || null;
      };
      type VeloDoc = {
        fnuci?: string;
        annule?: boolean;
        datePreparation?: unknown;
        dateChargement?: unknown;
        dateLivraisonScan?: unknown;
        dateMontage?: unknown;
        urlPhotoMontageEtiquette?: string;
        urlPhotoMontageQrVelo?: string;
        photoMontageUrl?: string;
      };
      const velos = vSnap.docs
        .filter((d) => !(d.data() as VeloDoc).annule)
        .map((d) => {
          const v = d.data() as VeloDoc;
          return {
            veloId: d.id,
            fnuci: (v.fnuci || "").trim() || null,
            datePreparation: isoOrNull(v.datePreparation),
            dateChargement: isoOrNull(v.dateChargement),
            dateLivraisonScan: isoOrNull(v.dateLivraisonScan),
            dateMontage: isoOrNull(v.dateMontage),
            urlPhotoMontageEtiquette: asUrl(v.urlPhotoMontageEtiquette),
            urlPhotoMontageQrVelo: asUrl(v.urlPhotoMontageQrVelo),
            photoMontageUrl: asUrl(v.photoMontageUrl),
          };
        });
      const avecFnuci = velos.filter((v) => !!v.fnuci);
      return {
        ok: true,
        clientId,
        entreprise: c.entreprise || "",
        adresse: c.adresse || "",
        ville: c.ville || "",
        nbVelosTotal: velos.length,
        nbVelosAvecFnuci: avecFnuci.length,
        nbVelosSansFnuci: velos.length - avecFnuci.length,
        fnuciAttendus: avecFnuci.map((v) => v.fnuci),
        velos,
      };
    }
    case "auditEffectifs": {
      // Migration de gas/Code.js:auditEffectifs vers Firestore. Croise les
      // verifications (collection mirrorée depuis GAS via syncFromGas) avec les
      // clients Firestore pour détecter les écarts entre nb vélos commandés et
      // effectif déclaré (règle CEE : 1 vélo max / salarié).
      // Source de vérité : `verifications` Firestore + `clients` Firestore.
      // Fallback GAS retiré : si Firestore est vide, on retourne 0 incohérence
      // (mieux que de planter sur un GAS down).
      const DOCS_AVEC_EFFECTIF: Record<string, true> = {
        DSN: true,
        LIASSE: true,
        ATTESTATION_URSSAF: true,
        URSSAF: true,
        ATTESTATION: true,
      };

      const verifSnap = await getDocs(collection(db, "verifications"));
      const clientSnap = await getDocs(collection(db, "clients"));

      type VerifAgg = {
        clientId: string;
        entreprise: string;
        effectifMax: number;
        effectifSource: string;
        verifIds: string[];
        nbDocs: number;
      };
      type DevisAgg = { nbVelosMax: number; sourceVerifId: string; nbDevis: number };

      const byClient: Record<string, VerifAgg> = {};
      const devisByClient: Record<string, DevisAgg> = {};

      for (const d of verifSnap.docs) {
        const v = d.data() as Record<string, unknown>;
        const cid = String(v.clientId || "");
        if (!cid) continue;
        const docType = String(v.docType || "").toUpperCase();

        if (docType === "DEVIS") {
          const vRaw = v.nbVelosDevis;
          if (vRaw != null && vRaw !== "") {
            const nbV = Number(vRaw);
            if (Number.isFinite(nbV) && nbV >= 0 && nbV < 10000) {
              const cur = devisByClient[cid];
              if (!cur) {
                devisByClient[cid] = { nbVelosMax: nbV, sourceVerifId: d.id, nbDevis: 1 };
              } else {
                cur.nbDevis++;
                if (nbV > cur.nbVelosMax) {
                  cur.nbVelosMax = nbV;
                  cur.sourceVerifId = d.id;
                }
              }
            }
          }
        }

        if (!DOCS_AVEC_EFFECTIF[docType]) continue;
        const effRaw = v.effectifDetected;
        if (effRaw == null || effRaw === "") continue;
        const eff = Number(effRaw);
        if (!Number.isFinite(eff) || eff < 0 || eff > 10000) continue;

        const ent = String(v.entreprise || "");
        if (!byClient[cid]) {
          byClient[cid] = {
            clientId: cid,
            entreprise: ent,
            effectifMax: eff,
            effectifSource: docType,
            verifIds: [d.id],
            nbDocs: 1,
          };
        } else {
          const b = byClient[cid];
          b.nbDocs++;
          b.verifIds.push(d.id);
          if (eff > b.effectifMax) {
            b.effectifMax = eff;
            b.effectifSource = docType;
          }
        }
      }

      type ClientAgg = { clientId: string; nbVelosCommandes: number; entreprise: string; siren: string };
      const clientById: Record<string, ClientAgg> = {};
      const allClients: ClientAgg[] = [];
      for (const d of clientSnap.docs) {
        const c = d.data() as Record<string, unknown>;
        const nbV = Number(c.nbVelosCommandes || 0);
        const ent = String(c.entreprise || "");
        const siren = String(c.siren || "").replace(/\s/g, "");
        const entry = { clientId: d.id, nbVelosCommandes: nbV, entreprise: ent, siren };
        clientById[d.id] = entry;
        allClients.push(entry);
      }

      // Incohérences par établissement
      const incoherences: Array<{
        clientId: string;
        entreprise: string;
        nbVelosCommandes: number;
        nbVelosDevis: number | null;
        nbDevis: number;
        effectifMax: number;
        effectifSource: string;
        ecart: number;
        nbDocs: number;
        verifIds: string[];
        suggestedTarget: number;
        sens: "trop_velos" | "pas_assez_velos";
      }> = [];

      for (const cid of Object.keys(byClient)) {
        const b = byClient[cid];
        const c = clientById[cid];
        if (!c) continue;
        const ecart = c.nbVelosCommandes - b.effectifMax;
        if (ecart === 0) continue;
        const dInfo = devisByClient[cid] || null;
        incoherences.push({
          clientId: cid,
          entreprise: c.entreprise || b.entreprise,
          nbVelosCommandes: c.nbVelosCommandes,
          nbVelosDevis: dInfo ? dInfo.nbVelosMax : null,
          nbDevis: dInfo ? dInfo.nbDevis : 0,
          effectifMax: b.effectifMax,
          effectifSource: b.effectifSource,
          ecart,
          nbDocs: b.nbDocs,
          verifIds: b.verifIds,
          suggestedTarget: b.effectifMax,
          sens: ecart > 0 ? "trop_velos" : "pas_assez_velos",
        });
      }
      incoherences.sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart));

      // Agrégation par SIREN (multi-établissements)
      type SirenAgg = {
        siren: string;
        entreprise: string;
        totalVelos: number;
        etablissements: Array<{ clientId: string; entreprise: string; nbVelos: number }>;
        effectifMax: number;
        effectifSource: string;
        nbDocs: number;
        verifIds: string[];
      };
      const sirenAgg: Record<string, SirenAgg> = {};
      for (const c of allClients) {
        if (!c.siren || c.siren === "0") continue;
        if (!sirenAgg[c.siren]) {
          sirenAgg[c.siren] = {
            siren: c.siren,
            entreprise: c.entreprise,
            totalVelos: 0,
            etablissements: [],
            effectifMax: 0,
            effectifSource: "",
            nbDocs: 0,
            verifIds: [],
          };
        }
        const s = sirenAgg[c.siren];
        s.totalVelos += c.nbVelosCommandes;
        s.etablissements.push({ clientId: c.clientId, entreprise: c.entreprise, nbVelos: c.nbVelosCommandes });
        const b = byClient[c.clientId];
        if (b) {
          s.nbDocs += b.nbDocs;
          s.verifIds = s.verifIds.concat(b.verifIds);
          if (b.effectifMax > s.effectifMax) {
            s.effectifMax = b.effectifMax;
            s.effectifSource = b.effectifSource;
          }
        }
      }

      const incoherencesParSiren: Array<{
        siren: string;
        entreprise: string;
        totalVelos: number;
        effectifMax: number;
        effectifSource: string;
        ecart: number;
        sens: "trop_velos" | "pas_assez_velos";
        nbEtablissements: number;
        etablissements: Array<{ clientId: string; entreprise: string; nbVelos: number }>;
        nbDocs: number;
        verifIds: string[];
      }> = [];
      for (const siren of Object.keys(sirenAgg)) {
        const s = sirenAgg[siren];
        if (s.etablissements.length < 2) continue;
        if (s.effectifMax === 0) continue;
        const ecart = s.totalVelos - s.effectifMax;
        if (ecart === 0) continue;
        incoherencesParSiren.push({
          siren,
          entreprise: s.entreprise,
          totalVelos: s.totalVelos,
          effectifMax: s.effectifMax,
          effectifSource: s.effectifSource,
          ecart,
          sens: ecart > 0 ? "trop_velos" : "pas_assez_velos",
          nbEtablissements: s.etablissements.length,
          etablissements: s.etablissements,
          nbDocs: s.nbDocs,
          verifIds: s.verifIds,
        });
      }
      incoherencesParSiren.sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart));

      // Clients sans pièce d'effectif (groupés par SIREN)
      const sansPieceParSiren: Record<string, {
        siren: string;
        entreprise: string;
        totalVelos: number;
        etablissements: Array<{ clientId: string; entreprise: string; nbVelos: number }>;
      }> = {};
      const sansPieceSansSiren: Array<{ clientId: string; entreprise: string; nbVelos: number }> = [];
      for (const c of allClients) {
        if (c.nbVelosCommandes <= 0) continue;
        if (byClient[c.clientId]) continue;
        if (c.siren && c.siren !== "0") {
          if (!sansPieceParSiren[c.siren]) {
            sansPieceParSiren[c.siren] = {
              siren: c.siren,
              entreprise: c.entreprise,
              totalVelos: 0,
              etablissements: [],
            };
          }
          const sp = sansPieceParSiren[c.siren];
          sp.totalVelos += c.nbVelosCommandes;
          sp.etablissements.push({ clientId: c.clientId, entreprise: c.entreprise, nbVelos: c.nbVelosCommandes });
        } else {
          sansPieceSansSiren.push({ clientId: c.clientId, entreprise: c.entreprise, nbVelos: c.nbVelosCommandes });
        }
      }
      // Si un SIREN a déjà au moins 1 établissement scanné, retirer le groupe
      for (const siren of Object.keys(sansPieceParSiren)) {
        if (sirenAgg[siren] && sirenAgg[siren].effectifMax > 0) {
          delete sansPieceParSiren[siren];
        }
      }
      const clientsSansPieceEffectif = Object.values(sansPieceParSiren);
      for (const c of sansPieceSansSiren) {
        clientsSansPieceEffectif.push({
          siren: "",
          entreprise: c.entreprise,
          totalVelos: c.nbVelos,
          etablissements: [c],
        });
      }
      clientsSansPieceEffectif.sort((a, b) => b.totalVelos - a.totalVelos);

      return {
        ok: true,
        total: incoherences.length,
        incoherences,
        incoherencesParSiren,
        totalSiren: incoherencesParSiren.length,
        clientsSansPieceEffectif,
        totalSansPiece: clientsSansPieceEffectif.length,
        nbClientsAvecEffectifDetecte: Object.keys(byClient).length,
      };
    }

    case "listEquipe": {
      // includeInactifs="true" → tout le monde, sinon seuls les actifs.
      // Parité avec gas listEquipe (gas/Code.js) consommé par /equipe.
      const includeInactifs = params.includeInactifs === "true";
      const baseQuery = includeInactifs
        ? collection(db, "equipe")
        : query(collection(db, "equipe"), where("actif", "==", true));
      const snap = await getDocs(baseQuery);
      const items = snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        const createdAt = data.createdAt as { toDate?: () => Date } | undefined;
        return {
          id: d.id,
          nom: (data.nom as string) ?? "",
          role: data.role,
          telephone: (data.telephone as string | null) ?? null,
          email: (data.email as string | null) ?? null,
          actif: !!data.actif,
          notes: (data.notes as string | null) ?? null,
          createdAt: createdAt?.toDate ? createdAt.toDate().toISOString() : null,
          hasCode: true,
          salaireJournalier: data.salaireJournalier ?? null,
          primeVelo: data.primeVelo ?? null,
        };
      });
      return { ok: true, items };
    }

    case "listVerifications": {
      // status ∈ {pending, validated, rejected, unassigned, "", "all"}.
      // Pour "all" / "" / "unassigned" → pas de filtre status. "unassigned"
      // est un filtre client-side (clientId vide), on remonte tout côté
      // serveur et la page filtre. Limite par défaut 1000 comme GAS.
      const status = params.status || "";
      const lim = Math.max(1, Math.min(5000, Number(params.limit || "1000") || 1000));
      const useStatusFilter = status === "pending" || status === "validated" || status === "rejected";
      // Pas d'orderBy serveur : combiné à un where, Firestore exige un index
      // composite (firestore.indexes.json est vide). On trie côté client après
      // récup, ce qui est OK pour ≤ lim docs.
      const q = useStatusFilter
        ? query(
            collection(db, "verifications"),
            where("status", "==", status),
            limit(lim),
          )
        : query(collection(db, "verifications"), limit(lim));
      const snap = await getDocs(q);
      const tsToIso = (x: unknown): string | undefined => {
        if (!x) return undefined;
        if (typeof x === "string") return x;
        const t = x as { toDate?: () => Date };
        return t?.toDate ? t.toDate().toISOString() : undefined;
      };
      const items = snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          id: d.id,
          receivedAt: tsToIso(data.receivedAt),
          clientId: data.clientId ?? "",
          entreprise: data.entreprise ?? "",
          docType: data.docType ?? "",
          driveUrl: data.driveUrl ?? data.storageUrl ?? "",
          fileName: data.fileName ?? "",
          fromEmail: data.fromEmail ?? "",
          subject: data.subject ?? "",
          effectifDetected: data.effectifDetected ?? "",
          nbVelosBefore: data.nbVelosBefore ?? "",
          nbVelosAfter: data.nbVelosAfter ?? "",
          status: data.status ?? "",
          notes: data.notes ?? "",
          messageId: data.messageId ?? "",
        };
      });
      // Tri client : receivedAt desc, fallback sur id pour stabilité.
      items.sort((a, b) => {
        const ra = (a.receivedAt as string) || "";
        const rb = (b.receivedAt as string) || "";
        if (ra !== rb) return rb.localeCompare(ra);
        return b.id.localeCompare(a.id);
      });
      return { ok: true, items };
    }

    case "archiveMembre": {
      // Soft-delete d'un membre d'équipe : actif=false. Préserve l'historique
      // (livraisons passées qui référencent l'id) tout en sortant le membre
      // des listes "actifs". gasGet historique → reproduit via updateDoc.
      const id = params.id;
      if (!id) throw new Error("id requis");
      await updateDoc(doc(db, "equipe", id), { actif: false });
      return { ok: true };
    }

    case "deleteLivraison": {
      // Soft-delete : statut="annulee". restoreLivraison remet à "planifiee".
      // Pas de delete physique car les vélos rattachés gardent une référence
      // (tourneeId/livraisonId) qu'on ne veut pas casser.
      const id = params.id;
      if (!id) throw new Error("id requis");
      await updateDoc(doc(db, "livraisons", id), {
        statut: "annulee",
        dateEffective: null,
      });
      return { ok: true };
    }

    case "restoreLivraison": {
      const id = params.id;
      if (!id) throw new Error("id requis");
      await updateDoc(doc(db, "livraisons", id), {
        statut: "planifiee",
        dateEffective: null,
      });
      return { ok: true };
    }

    case "cancelTournee": {
      // Annule toutes les livraisons d'une tournée (statut="annulee").
      // Utilisé par le bouton "Annuler la tournée" dans /livraisons.
      const tourneeId = params.tourneeId;
      if (!tourneeId) throw new Error("tourneeId requis");
      const snap = await getDocs(
        query(collection(db, "livraisons"), where("tourneeId", "==", tourneeId)),
      );
      // writeBatch limité à 500 ops — au-delà on découpe (une tournée fait
      // rarement plus de 50 livraisons mais on reste safe).
      const docs = snap.docs.filter((d) => (d.data() as { statut?: string }).statut !== "annulee");
      for (let i = 0; i < docs.length; i += 400) {
        const batch = writeBatch(db);
        for (const d of docs.slice(i, i + 400)) {
          batch.update(d.ref, { statut: "annulee", dateEffective: null });
        }
        await batch.commit();
      }
      return { ok: true, count: docs.length };
    }

    case "countPendingVerifications": {
      // Badge sidebar admin (poll 60s). On compte uniquement les verifs
      // status=pending. getDocs renvoie le size sans frais supplémentaires
      // significatifs vs un getCountFromServer (collection limitée).
      const snap = await getDocs(
        query(collection(db, "verifications"), where("status", "==", "pending")),
      );
      return { ok: true, count: snap.size };
    }

    default:
      return null; // signal "fallback GAS"
  }
}

export async function deleteVerification(id: string) {
  await deleteDoc(doc(db, "verifications", id));
}
