import {
  isMigrated,
  runFirestoreAction,
  runFirestoreGet,
} from "./firestore-actions";

const GAS_URL = process.env.NEXT_PUBLIC_GAS_URL || "";
const USE_FIREBASE = process.env.NEXT_PUBLIC_USE_FIREBASE === "1";

/**
 * Wrapper transparent : en mode Firebase, on tente d'abord une action Firestore
 * équivalente. Si l'action n'est pas migrée (Gemini, Drive, routing externe),
 * on tombe sur l'appel GAS historique.
 *
 * Les pages continuent d'appeler gasPost / gasGet / gasUpload comme avant.
 */

async function gasFetch(action: string, init?: RequestInit, params?: Record<string, string>) {
  if (!GAS_URL) {
    throw new Error("NEXT_PUBLIC_GAS_URL non configuré et action non migrée Firestore");
  }
  const url = new URL(GAS_URL);
  url.searchParams.set("action", action);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), { redirect: "follow", ...init });
  return res.json();
}

export async function gasGet(action: string, params?: Record<string, string>) {
  if (USE_FIREBASE) {
    const result = await runFirestoreGet(action, params || {});
    if (result !== null) return result;
  }
  return gasFetch(action, undefined, params);
}

export async function gasPost(action: string, body: unknown) {
  if (USE_FIREBASE && isMigrated(action)) {
    return runFirestoreAction(action, body as Record<string, unknown>);
  }
  return gasFetch(action, undefined, {
    body: encodeURIComponent(JSON.stringify(body)),
  });
}

export async function gasUpload(action: string, body: unknown) {
  if (USE_FIREBASE && isMigrated(action)) {
    return runFirestoreAction(action, body as Record<string, unknown>);
  }
  if (!GAS_URL) {
    throw new Error("NEXT_PUBLIC_GAS_URL non configuré et action non migrée Firestore");
  }
  const url = new URL(GAS_URL);
  url.searchParams.set("action", action);
  const res = await fetch(url.toString(), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "text/plain" },
    redirect: "follow",
  });
  return res.json();
}
