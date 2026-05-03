/**
 * Helpers WhatsApp Click-to-Chat (wa.me).
 *
 * Yoann 2026-05-03 — pas d'API Meta (pas approuvé), on utilise les liens
 * `https://wa.me/<numero>?text=<message>` qui ouvrent WhatsApp Business
 * sur le téléphone de l'utilisateur avec le message pré-rempli. L'utilisateur
 * valide manuellement l'envoi. Suffisant pour un volume de ~12 envois/jour.
 *
 * Avantages :
 *  - Aucune dépendance, marche depuis n'importe quel WhatsApp (perso/Business)
 *  - Pas de templates Meta à faire approuver
 *  - Pas de quota / pas de coût
 *  - Marche sur mobile (ouvre l'app) ET desktop (ouvre web.whatsapp.com)
 */

/**
 * Normalise un numéro FR vers format international E.164 sans + ni espaces.
 * Cas typiques :
 *  - "0660757989"        → "33660757989"
 *  - "+33 6 60 75 79 89" → "33660757989"
 *  - "33660757989"       → "33660757989"
 *  - "660757989"         → "33660757989" (9 chiffres, on assume FR)
 *
 * Renvoie null si entrée vide ou non parsable en numéro FR plausible.
 * Pour les numéros internationaux non-FR, fournir directement les chiffres
 * sans 0 initial.
 */
export function normalizePhoneFR(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("33") && digits.length >= 11) return digits;
  if (digits.startsWith("0") && digits.length === 10) return "33" + digits.slice(1);
  if (digits.length === 9) return "33" + digits;
  // numéro étranger ou format inconnu : on retourne tel quel, wa.me se débrouille
  return digits.length >= 7 ? digits : null;
}

/** Génère une URL wa.me prête à cliquer. Renvoie null si le numéro est
 *  inutilisable (vide ou trop court). */
export function whatsappLink(
  phone: string | null | undefined,
  message: string,
): string | null {
  const num = normalizePhoneFR(phone);
  if (!num) return null;
  return `https://wa.me/${num}?text=${encodeURIComponent(message)}`;
}

/** Ouvre WhatsApp dans un nouvel onglet/app avec le message pré-rempli.
 *  Renvoie true si le lien a pu être ouvert, false sinon (numéro invalide).
 *  À appeler sur un événement utilisateur (sinon le browser bloque
 *  window.open). */
export function openWhatsApp(
  phone: string | null | undefined,
  message: string,
): boolean {
  const url = whatsappLink(phone, message);
  if (!url) return false;
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Templates de messages prédéfinis (à utiliser comme base, l'utilisateur
// peut éditer dans WhatsApp avant d'envoyer).
// ─────────────────────────────────────────────────────────────────────────

const formatDateFR = (iso: string | null | undefined): string => {
  if (!iso) return "prochainement";
  try {
    const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso);
    return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  } catch {
    return iso;
  }
};

/** Validation pré-livraison : on demande au client de confirmer la date+créneau. */
export function tplValidationLivraison(params: {
  contact?: string | null;
  entreprise: string;
  nbVelos: number;
  datePrevue: string | null;
  creneau?: string | null; // "9h00–11h00"
  adresse?: string | null;
  signature?: string | null;
}): string {
  const greet = params.contact ? `Bonjour ${params.contact}` : `Bonjour ${params.entreprise}`;
  const dateStr = formatDateFR(params.datePrevue);
  const lines = [
    greet + ",",
    "",
    `Vélos Cargo (Artisans Verts Energy). Nous prévoyons de vous livrer ${params.nbVelos} vélo${params.nbVelos > 1 ? "s" : ""} cargo le ${dateStr}${params.creneau ? ` entre ${params.creneau}` : ""}${params.adresse ? `, à l'adresse ${params.adresse}` : ""}.`,
    "",
    "Merci de confirmer votre disponibilité.",
    "",
    "Cordialement,",
    params.signature || "Vélos Cargo",
  ];
  return lines.join("\n");
}

/** Brief tournée pour chauffeur/chef d'équipe. Court, l'utilisateur copie
 *  ensuite le détail depuis le brief généré. */
export function tplBriefChauffeur(params: {
  prenom?: string | null;
  datePrevue: string | null;
  nbClients: number;
  nbVelos: number;
  heureDepart?: string | null;
  signature?: string | null;
}): string {
  const greet = params.prenom ? `Salut ${params.prenom}` : "Salut";
  const dateStr = formatDateFR(params.datePrevue);
  const lines = [
    greet + ",",
    "",
    `Voici ton planning du ${dateStr} :`,
    `🚛 ${params.nbClients} client${params.nbClients > 1 ? "s" : ""} · ${params.nbVelos} vélo${params.nbVelos > 1 ? "s" : ""}`,
    params.heureDepart ? `📍 Départ ${params.heureDepart}` : "",
    "",
    "(Brief détaillé à suivre)",
    "",
    params.signature || "Vélos Cargo",
  ].filter(Boolean);
  return lines.join("\n");
}

/** Message générique court : juste un bonjour signé. L'utilisateur tape
 *  ensuite le contenu dans WhatsApp. */
export function tplGenerique(params: {
  contact?: string | null;
  entreprise?: string | null;
  signature?: string | null;
}): string {
  const greet = params.contact
    ? `Bonjour ${params.contact}`
    : params.entreprise
      ? `Bonjour ${params.entreprise}`
      : "Bonjour";
  return `${greet},\n\n\n\n${params.signature || "Vélos Cargo"}`;
}
