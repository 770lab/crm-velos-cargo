"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { gasPost } from "@/lib/gas";

// Scan FNUCI à la PRÉP via scannette Bluetooth (Inateck BCST-72 ou similaire)
// 30-04 17h30, demande Yoann post-DOSTLAR : Gemini hallucine trop, scannette
// physique = 99.99% fiabilité. Workflow :
//
// 1. La scannette est appairée en mode HID (= clavier Bluetooth) sur l'iPhone.
// 2. Ce composant a un input invisible focused en permanence.
// 3. Quand le préparateur bipe un sticker BicyCode, le scanner envoie
//    "BCXXXXXXXX\n" → arrive comme une frappe clavier dans l'input.
// 4. Sur Enter (\n) reçu, on valide le code : format strict BC + 8 chars,
//    puis appel server : assignFnuciToClient (si forceClientId) + markVeloPrepare.
// 5. Beep audio + vibration + entrée verte/rouge dans la liste live.
//
// La preuve photo CEE est faite plus tard par le chauffeur au chargement
// (markVeloCharge avec photo persistée). Ici à la prep, la scannette suffit
// comme source de vérité du FNUCI.

type FeedbackEntry = {
  id: number;
  fnuci: string;
  ok: boolean;
  message: string;
  at: number;
};

const FNUCI_REGEX = /^BC[A-Z0-9]{8}$/;

function beep(ok: boolean) {
  try {
    const w = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctx = w.AudioContext || w.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 1200 : 220;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.value = 0.15;
    o.start();
    setTimeout(() => {
      o.stop();
      ctx.close();
    }, ok ? 100 : 350);
  } catch {}
}

export type ScannetteClientOption = {
  clientId: string;
  entreprise: string;
  total: number;
  done: number;
};

export default function ScannetteCapture({
  tourneeId,
  userId,
  onAfter,
  forceClientId,
  bypassOrderLock = false,
}: {
  tourneeId: string;
  userId: string | null;
  onAfter?: () => void;
  /** Client ciblé pour assigner les FNUCI scannés. Obligatoire en prep. */
  forceClientId?: string;
  bypassOrderLock?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const bufferRef = useRef<string>("");
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastValidatedAt, setLastValidatedAt] = useState<number>(0);
  const idRef = useRef<number>(0);

  const pushFeedback = useCallback((fnuci: string, ok: boolean, message: string) => {
    idRef.current += 1;
    const entry: FeedbackEntry = {
      id: idRef.current,
      fnuci,
      ok,
      message,
      at: Date.now(),
    };
    setFeedback((prev) => [entry, ...prev].slice(0, 20));
  }, []);

  const validateScan = useCallback(
    async (code: string) => {
      const fn = code.trim().toUpperCase();
      if (!FNUCI_REGEX.test(fn)) {
        beep(false);
        pushFeedback(fn || "(vide)", false, `Format invalide (attendu BC + 8 chars)`);
        return;
      }
      if (!forceClientId) {
        beep(false);
        pushFeedback(fn, false, "Pas de client sélectionné — ouvre la prep depuis un client");
        return;
      }
      setBusy(true);
      try {
        const a = (await gasPost("assignFnuciToClient", {
          fnuci: fn,
          clientId: forceClientId,
        })) as {
          ok?: boolean;
          error?: string;
          alreadySameClient?: boolean;
          existingClientName?: string | null;
        };
        if (a.error && !a.alreadySameClient) {
          beep(false);
          pushFeedback(
            fn,
            false,
            a.existingClientName ? `Déjà chez ${a.existingClientName}` : a.error,
          );
          return;
        }
        const m = (await gasPost("markVeloPrepare", {
          fnuci: fn,
          tourneeId,
          userId: userId || "",
          bypassOrderLock: bypassOrderLock || undefined,
        })) as { ok?: boolean; error?: string; clientName?: string | null };
        if (m.error) {
          beep(false);
          pushFeedback(fn, false, m.error);
          return;
        }
        beep(true);
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          navigator.vibrate(40);
        }
        pushFeedback(fn, true, `✓ ${m.clientName ? "préparé · " + m.clientName : "préparé"}`);
        setLastValidatedAt(Date.now());
        if (onAfter) onAfter();
      } catch (e) {
        beep(false);
        pushFeedback(fn, false, e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [forceClientId, tourneeId, userId, bypassOrderLock, onAfter, pushFeedback],
  );

  // Listener keydown global : la scannette en mode HID Bluetooth tape les
  // caractères dans le focus actuel. On écoute aussi globalement au cas où
  // l'input invisible perdrait le focus (ex: opérateur clique ailleurs).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Si l'utilisateur tape dans un autre champ texte explicitement, on
      // n'intercepte pas (= il fait une saisie manuelle ailleurs).
      const target = e.target as HTMLElement | null;
      const isOurInput = target === inputRef.current;
      const isOtherInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target as HTMLElement | null)?.isContentEditable;
      if (isOtherInput && !isOurInput) return;

      // Enter -> fin du scan, on valide le buffer
      if (e.key === "Enter" || e.key === "\n" || e.key === "\r") {
        e.preventDefault();
        const code = bufferRef.current;
        bufferRef.current = "";
        if (inputRef.current) inputRef.current.value = "";
        if (code.length > 0) void validateScan(code);
        return;
      }

      // Char alphanum (le scanner envoie chaque char comme keydown)
      if (e.key.length === 1 && /[A-Za-z0-9]/.test(e.key)) {
        bufferRef.current += e.key.toUpperCase();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    // Re-focus l'input invisible au mount + après chaque scan validé
    const focus = () => inputRef.current?.focus();
    focus();
    const interval = setInterval(focus, 1000);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearInterval(interval);
    };
  }, [validateScan]);

  const okCount = feedback.filter((f) => f.ok).length;
  const errCount = feedback.filter((f) => !f.ok).length;

  return (
    <div className="space-y-3">
      <div className="bg-emerald-50 border-2 border-emerald-400 rounded-xl p-3 text-center">
        <div className="text-[11px] uppercase tracking-wider text-emerald-700 font-bold">
          📡 Mode scannette actif
        </div>
        <div className="text-sm text-emerald-900 mt-1">
          Bipe les stickers BicyCode des vélos l&apos;un après l&apos;autre.
          {forceClientId
            ? " Chaque scan affecte le FNUCI au client courant."
            : " ⚠ Aucun client sélectionné — la prep ciblera le 1er slot vide."}
        </div>
        <div className="mt-2 flex justify-center gap-3 text-xs">
          <span className="text-emerald-800 font-semibold">{okCount} validés</span>
          {errCount > 0 && <span className="text-red-700 font-semibold">{errCount} erreurs</span>}
          {busy && <span className="text-blue-700 animate-pulse">⏳ Écriture…</span>}
        </div>
      </div>

      {/* Input invisible focused permanent : capture les frappes Bluetooth HID */}
      <input
        ref={inputRef}
        type="text"
        autoFocus
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        onBlur={() => setTimeout(() => inputRef.current?.focus(), 100)}
        className="absolute opacity-0 pointer-events-none w-px h-px"
        aria-hidden="true"
      />

      {/* Pulse vert au dernier scan validé pour feedback visuel */}
      <div
        className={`text-center text-xs text-gray-500 transition-all ${
          Date.now() - lastValidatedAt < 1000 ? "scale-110 text-emerald-600 font-bold" : ""
        }`}
      >
        En attente du prochain bip…
      </div>

      {feedback.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-2 max-h-96 overflow-y-auto">
          <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-2 px-1">
            Derniers scans
          </div>
          <ul className="space-y-1">
            {feedback.map((f) => (
              <li
                key={f.id}
                className={`flex items-center justify-between gap-2 text-xs px-2 py-1.5 rounded ${
                  f.ok
                    ? "bg-emerald-50 border border-emerald-200 text-emerald-900"
                    : "bg-red-50 border border-red-200 text-red-900"
                }`}
              >
                <span className="font-mono font-bold">{f.fnuci}</span>
                <span className="truncate">{f.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="text-[11px] text-gray-500 text-center px-2">
        💡 Astuce : si le scan ne marche pas, vérifie que la scannette est appairée en
        Bluetooth sur l&apos;iPhone (mode HID / clavier). Tape une fois dans un champ
        texte de l&apos;app pour donner le focus à l&apos;app si le scan ne s&apos;enregistre pas.
      </div>
    </div>
  );
}
