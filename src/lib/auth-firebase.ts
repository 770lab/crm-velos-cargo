"use client";

import {
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { auth, googleProvider } from "./firebase";

const PIN_PREFIX = "vc-";
const SYNTHETIC_DOMAIN = "velos-cargo.local";
const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "velos-cargo";
const REGION = "europe-west1";

function loginUrl(): string {
  return `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/loginWithPin`;
}

/**
 * Convertit un PIN à 4 chiffres en mot de passe Firebase (>= 6 chars).
 * Côté UI, l'utilisateur ne tape que le PIN.
 */
export function pinToPassword(pin: string): string {
  return `${PIN_PREFIX}${pin}`;
}

/**
 * Devine l'email Firebase à partir du nom saisi.
 * Si l'utilisateur saisit un email valide, on l'utilise tel quel.
 * Sinon on construit un email synthétique cohérent avec seed-equipe.mjs.
 */
export function nameToEmail(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const slug = trimmed
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (/^\d+[a-z]?$/.test(slug)) {
    return `monteur-${slug}@${SYNTHETIC_DOMAIN}`;
  }
  return `${slug}@${SYNTHETIC_DOMAIN}`;
}

export async function signInWithPin(nameOrEmail: string, pin: string): Promise<User> {
  // 1) Si l'utilisateur a tapé un email, on tente direct.
  if (nameOrEmail.includes("@")) {
    const cred = await signInWithEmailAndPassword(
      auth,
      nameOrEmail.trim().toLowerCase(),
      pinToPassword(pin),
    );
    return cred.user;
  }

  // 2) Sinon, on demande au backend de résoudre le nom → email réel
  //    (utile pour les comptes avec vrai email type yoann@artisansverts.energy).
  try {
    const res = await fetch(loginUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nom: nameOrEmail, pin }),
    });
    const json = (await res.json()) as
      | { ok: true; email: string }
      | { ok: false; error: string };
    if (res.ok && json.ok) {
      const cred = await signInWithEmailAndPassword(
        auth,
        json.email,
        pinToPassword(pin),
      );
      return cred.user;
    }
  } catch {
    // ignore — fallback ci-dessous
  }
  // 3) Fallback : email synthétique pour les membres sans vrai email
  const cred = await signInWithEmailAndPassword(
    auth,
    nameToEmail(nameOrEmail),
    pinToPassword(pin),
  );
  return cred.user;
}

export async function signInWithGoogle(): Promise<User> {
  const cred = await signInWithPopup(auth, googleProvider);
  return cred.user;
}

export async function signOut(): Promise<void> {
  await fbSignOut(auth);
}
