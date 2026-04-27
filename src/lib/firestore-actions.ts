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
      const ref = await addDoc(collection(db, "clients"), {
        ...body,
        nbVelosCommandes: Number(body.nbVelosCommandes) || 0,
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
      const ref = await addDoc(collection(db, "livraisons"), {
        ...applyMaybeDates(body),
        statut: body.statut || "planifiee",
        createdAt: ts(),
      });
      return { ok: true, id: ref.id };
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
      const livraisonId = getString(body, "livraisonId") || getString(body, "id");
      if (!livraisonId) throw new Error("livraisonId requis");
      const fields: Body = { updatedAt: ts() };
      for (const k of [
        "tourneeId",
        "chauffeurId",
        "chefEquipeIds",
        "monteurIds",
        "preparateurIds",
        "mode",
      ]) {
        if (k in body) fields[k] = body[k];
      }
      await updateDoc(doc(db, "livraisons", livraisonId), fields);
      return { ok: true };
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
      const livraisonId = getString(body, "livraisonId") || "no-livraison";
      const veloId = getString(body, "veloId");
      const stage = getString(body, "stage") || "monte";
      const photoData = getRequired(body, "photoData");
      const fileName = `${veloId || "global"}-${stage}-${Date.now()}.jpg`;
      const url = await uploadDataUrl(
        `montage/${livraisonId}/${fileName}`,
        photoData,
        "image/jpeg",
      );
      if (veloId) {
        const stageFieldMap: Record<string, string> = {
          etiquette: "photos.montageEtiquette",
          qr: "photos.montageQrVelo",
          monte: "photos.montageGenerale",
        };
        const field = stageFieldMap[stage] || "photos.montageGenerale";
        await updateDoc(doc(db, "velos", veloId), {
          [field]: url,
          dateMontage: ts(),
          updatedAt: ts(),
        });
      }
      return { ok: true, url };
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
      const id = params.id;
      if (!id) throw new Error("id requis");
      const snap = await getDoc(doc(db, "clients", id));
      if (!snap.exists()) return { error: "Client introuvable" };
      return { id: snap.id, ...snap.data() };
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
    default:
      return null; // signal "fallback GAS"
  }
}

export async function deleteVerification(id: string) {
  await deleteDoc(doc(db, "verifications", id));
}
