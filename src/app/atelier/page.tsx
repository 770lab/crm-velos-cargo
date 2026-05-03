"use client";

// Yoann 2026-05-03 — Page scanner chef d atelier (workflow #44).
// Le chef scanne chaque carton avec sa scannette/téléphone, sélectionne
// le client à servir et affilie le vélo. Avant : c était Naomi (préparateur)
// qui faisait l affiliation. Maintenant les monteurs ont une scannette,
// et le chef supervise l affiliation jour J avant le montage.
//
// URL : /atelier?id=<sessionId> (query param car static export Next.js 16
// ne supporte pas les routes dynamiques sans generateStaticParams).
//
// Workflow :
//   1. Le chef ouvre /atelier?id=xxx (depuis le bouton "📷 Ouvrir l atelier"
//      du modal session atelier)
//   2. Voir : liste clients candidats (Voronoi depuis entrepôt session)
//      avec compteur "X / Y vélos affiliés" par client
//   3. Sélectionner client → bouton "📷 Scanner un carton"
//   4. Photo du sticker FNUCI → Gemini extrait → assignFnuciToClient
//   5. Marquer aussi préparé (markVeloPrepare avec preparateurId = chefId)
//
// Réutilise les actions existantes :
//   - extractFnuciFromImage (Cloud Function)
//   - assignFnuciToClient (firestore action)
//   - markVeloPrepare (firestore action)
import { Suspense, useEffect, useState, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useCurrentUser } from "@/lib/current-user";
import { gasPost, gasUpload } from "@/lib/gas";

export default function AtelierWrapper() {
  return (
    <Suspense fallback={<div className="p-6 text-center text-gray-400">Chargement…</div>}>
      <AtelierPage />
    </Suspense>
  );
}

type SessionDoc = {
  id: string;
  date: string;
  entrepotId: string;
  entrepotNom: string;
  monteurIds: string[];
  monteurNoms: string[];
  chefId: string | null;
  chefNom: string | null;
  quantitePrevue: number | null;
  statut: string;
  notes: string | null;
};

type Client = {
  id: string;
  entreprise: string;
  ville: string;
  codePostal: string;
  nbVelosCommandes: number;
  velosLivres: number;
  velosAffilies: number;
  reste: number;
  distance: number;
};

function haversineKm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 6371;
  const dLat = ((la2 - la1) * Math.PI) / 180;
  const dLng = ((lo2 - lo1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((la1 * Math.PI) / 180) * Math.cos((la2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function compressImage(file: File, maxDim = 1280, quality = 0.85): Promise<{ base64: string; mimeType: string }> {
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * ratio);
  const h = Math.round(bitmap.height * ratio);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b!), "image/jpeg", quality),
  );
  // Yoann 2026-05-03 : passé à FileReader. Avant : String.fromCharCode(...new
  // Uint8Array(buf)) qui plantait "Maximum call stack size exceeded" sur
  // images > qq centaines de KB (le spread crée des centaines de milliers
  // d args sur la stack).
  const dataUrl: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error("FileReader KO"));
    reader.readAsDataURL(blob);
  });
  // dataUrl = "data:image/jpeg;base64,XXXX"
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : "";
  return { base64, mimeType: "image/jpeg" };
}

function AtelierPage() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("id") || "";
  const user = useCurrentUser();

  const [session, setSession] = useState<SessionDoc | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedClientId, setSelectedClientId] = useState<string>("");
  const [scanning, setScanning] = useState(false);
  const [lastResult, setLastResult] = useState<{ ok: boolean; msg: string; fnuci?: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [scannetteCode, setScannetteCode] = useState("");
  const scannetteInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setLoading(false);
      return;
    }
    let alive = true;
    (async () => {
      setLoading(true);
      const { collection, doc, getDoc, getDocs } = await import("firebase/firestore");
      const { db } = await import("@/lib/firebase");
      const sRef = doc(db, "sessionsMontageAtelier", sessionId);
      const sSnap = await getDoc(sRef);
      if (!sSnap.exists()) {
        if (alive) setLoading(false);
        return;
      }
      const sd = sSnap.data() as Record<string, unknown>;
      const sessionData: SessionDoc = {
        id: sSnap.id,
        date: String(sd.date || ""),
        entrepotId: String(sd.entrepotId || ""),
        entrepotNom: String(sd.entrepotNom || ""),
        monteurIds: Array.isArray(sd.monteurIds) ? (sd.monteurIds as string[]) : [],
        monteurNoms: Array.isArray(sd.monteurNoms) ? (sd.monteurNoms as string[]) : [],
        chefId: typeof sd.chefId === "string" ? sd.chefId : null,
        chefNom: typeof sd.chefNom === "string" ? sd.chefNom : null,
        quantitePrevue: typeof sd.quantitePrevue === "number" ? sd.quantitePrevue : null,
        statut: String(sd.statut || "planifiee"),
        notes: typeof sd.notes === "string" ? sd.notes : null,
      };
      if (!alive) return;
      setSession(sessionData);

      // Voronoi : récupère tous les entrepôts non-fournisseur non-éphémère
      const allESnap = await getDocs(collection(db, "entrepots"));
      type Ent = { id: string; lat: number; lng: number };
      const allE: Ent[] = [];
      for (const d of allESnap.docs) {
        const o = d.data() as Record<string, unknown>;
        if (o.dateArchivage) continue;
        if (o.role === "fournisseur" || o.role === "ephemere") continue;
        if (typeof o.lat !== "number" || typeof o.lng !== "number") continue;
        allE.push({ id: d.id, lat: o.lat, lng: o.lng });
      }

      // Clients candidats : Voronoi → ceux dont CET entrepôt est le + proche
      const cSnap = await getDocs(collection(db, "clients"));
      const clientsMap = new Map<string, Client>();
      for (const d of cSnap.docs) {
        const o = d.data() as Record<string, unknown>;
        if (typeof o.latitude !== "number" || typeof o.longitude !== "number") continue;
        const cmd = Number(o.nbVelosCommandes || 0);
        if (cmd <= 0) continue;
        let bestId = "";
        let bestD = Infinity;
        for (const e of allE) {
          const dist = haversineKm(o.latitude as number, o.longitude as number, e.lat, e.lng);
          if (dist < bestD) { bestD = dist; bestId = e.id; }
        }
        if (bestId !== sessionData.entrepotId) continue;
        const stats = (o.stats as { livres?: number } | undefined) || {};
        clientsMap.set(d.id, {
          id: d.id,
          entreprise: String(o.entreprise || ""),
          ville: String(o.ville || ""),
          codePostal: String(o.codePostal || ""),
          nbVelosCommandes: cmd,
          velosLivres: Number(stats.livres || 0),
          velosAffilies: 0,
          reste: 0,
          distance: bestD,
        });
      }

      // Compte vélos affiliés (avec FNUCI) par client — 1 seule query.
      // Yoann 2026-05-03 : à la session atelier les vélos peuvent ne pas
      // encore exister (pas de tournée planifiée). Le compteur affiché =
      // vélos avec FNUCI = "déjà scannés/affiliés à la session". reste =
      // nbVelosCommandes - velosAvecFnuci, peu importe que les vélos
      // existent ou pas (ils seront créés à la volée par assignFnuciToClient).
      const allVSnap = await getDocs(collection(db, "velos"));
      const affiliesByClient = new Map<string, number>();
      for (const vd of allVSnap.docs) {
        const v = vd.data() as { clientId?: string; fnuci?: string | null; annule?: boolean };
        if (v.annule) continue;
        if (!v.fnuci) continue;
        const cid = String(v.clientId || "");
        if (!cid) continue;
        affiliesByClient.set(cid, (affiliesByClient.get(cid) || 0) + 1);
      }
      for (const c of clientsMap.values()) {
        c.velosAffilies = affiliesByClient.get(c.id) || 0;
        c.reste = Math.max(0, c.nbVelosCommandes - c.velosAffilies);
      }

      // Yoann 2026-05-03 : tolérance 0 %. Si reste = 0 → exclu. Sinon listé.
      // Si nbVelosCommandes saisi à tort (ex 30 au lieu de 28), corriger
      // dans la fiche client (pas via tolérance).
      const candidats = Array.from(clientsMap.values())
        .filter((c) => c.reste > 0)
        .sort((a, b) => a.distance - b.distance);
      if (alive) setClients(candidats);
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [sessionId, refreshKey]);

  const totalAffilies = useMemo(() => clients.reduce((s, c) => s + c.velosAffilies, 0), [clients]);
  const totalRestants = useMemo(() => clients.reduce((s, c) => s + c.reste, 0), [clients]);
  const totalCommandes = useMemo(() => clients.reduce((s, c) => s + c.nbVelosCommandes, 0), [clients]);

  // Yoann 2026-05-03 — workflow réel : c est la SCANNETTE physique (USB/BT)
  // qui tape le FNUCI dans l input + Enter automatique. La caméra/photo est
  // un fallback si la scannette ne lit pas (sticker abîmé). Pas de Gemini
  // Vision ici : direct le code lu par la scannette → assignFnuciToClient.

  // Affilie un FNUCI déjà identifié (que ce soit via scannette ou photo)
  const affilierFnuci = async (fnuciRaw: string) => {
    const fnuci = fnuciRaw.trim().toUpperCase();
    if (!fnuci) return;
    if (!selectedClientId) return alert("Sélectionne un client avant de scanner");
    setScanning(true);
    setLastResult(null);
    try {
      const aff = (await gasPost("assignFnuciToClient", {
        clientId: selectedClientId,
        fnuci,
      })) as { ok?: boolean; error?: string; code?: string };
      if (aff.ok === false || aff.error) {
        setLastResult({ ok: false, msg: `FNUCI ${fnuci} : ${aff.error}` });
        return;
      }
      const userId = session?.chefId || user?.id || null;
      if (userId) {
        await gasPost("markVeloPrepare", { fnuci, userId });
      }
      const cliNom = clients.find((c) => c.id === selectedClientId)?.entreprise || "?";
      setLastResult({ ok: true, msg: `✓ ${fnuci} → ${cliNom} (préparé)`, fnuci });
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setLastResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setScanning(false);
    }
  };

  const onScannetteSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = scannetteCode.trim();
    setScannetteCode("");
    if (!code) return;
    await affilierFnuci(code);
    // Re-focus pour scan suivant
    setTimeout(() => scannetteInputRef.current?.focus(), 50);
  };

  // Fallback photo+Gemini si scannette n arrive pas à lire
  const processPhoto = async (file: File) => {
    if (!selectedClientId) return alert("Sélectionne un client avant de scanner");
    setScanning(true);
    setLastResult(null);
    let etape = "init";
    try {
      etape = "compress";
      console.log("[atelier] photo size before compress:", file.size, "bytes");
      const compressed = await compressImage(file);
      console.log("[atelier] base64 size after compress:", compressed.base64.length, "chars");
      etape = "upload";
      const ident = (await gasUpload("extractFnuciFromImage", {
        imageBase64: compressed.base64,
        mimeType: compressed.mimeType,
        etape: "identify",
      })) as { ok?: boolean; extracted?: string[]; error?: string };
      etape = "parse";
      if (!ident.ok || !ident.extracted || ident.extracted.length === 0) {
        setLastResult({ ok: false, msg: "Aucun FNUCI lisible. Reprends une photo plus nette." });
        setScanning(false);
        return;
      }
      const fnuci = ident.extracted[0];
      setScanning(false);
      await affilierFnuci(fnuci);
    } catch (e) {
      console.error("[atelier] processPhoto KO at etape=", etape, e);
      setLastResult({ ok: false, msg: `[${etape}] ${e instanceof Error ? e.message : String(e)}` });
      setScanning(false);
    }
  };

  const onScanFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await processPhoto(file);
  };

  // Auto-focus input scannette quand un client est sélectionné
  useEffect(() => {
    if (selectedClientId && scannetteInputRef.current) {
      scannetteInputRef.current.focus();
    }
  }, [selectedClientId]);

  if (!sessionId) {
    return (
      <div className="p-6 text-center">
        <p className="text-red-600">Paramètre id manquant dans l URL</p>
        <Link href="/livraisons" className="text-blue-600 hover:underline">← Retour livraisons</Link>
      </div>
    );
  }
  if (loading) return <div className="p-6 text-center text-gray-500">Chargement…</div>;
  if (!session) return <div className="p-6 text-center text-red-600">Session introuvable</div>;

  const selectedClient = clients.find((c) => c.id === selectedClientId);

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">🔧 Atelier · {session.entrepotNom}</h1>
          <p className="text-sm text-gray-600">
            {session.date} · {session.monteurNoms.length} monteurs : {session.monteurNoms.join(", ")}
            {session.chefNom && <> · 👷 {session.chefNom}</>}
          </p>
        </div>
        <Link href="/livraisons" className="text-xs text-blue-600 hover:underline">← Retour</Link>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-center">
          <div className="text-2xl font-bold text-emerald-900">{totalAffilies}</div>
          <div className="text-[10px] uppercase text-emerald-700">Affiliés</div>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-center">
          <div className="text-2xl font-bold text-amber-900">{totalRestants}</div>
          <div className="text-[10px] uppercase text-amber-700">Restants</div>
        </div>
        <div className="bg-gray-100 border border-gray-200 rounded p-3 text-center">
          <div className="text-2xl font-bold">{totalCommandes}</div>
          <div className="text-[10px] uppercase text-gray-500">Total clients</div>
        </div>
      </div>

      <div className="bg-white border rounded-lg p-3">
        <div className="text-sm font-semibold mb-2">📦 Client à affilier</div>
        {clients.length === 0 ? (
          <div className="text-sm text-gray-400 italic">Aucun client à servir depuis cet entrepôt.</div>
        ) : (
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {clients.map((c) => {
              const isSel = c.id === selectedClientId;
              const pct = c.nbVelosCommandes > 0 ? Math.round((c.velosAffilies / c.nbVelosCommandes) * 100) : 0;
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedClientId(c.id)}
                  className={`w-full text-left p-2 rounded border ${isSel ? "bg-blue-50 border-blue-400" : "bg-white border-gray-200 hover:bg-gray-50"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold truncate flex-1">
                      {c.entreprise}
                      <span className="text-[10px] text-gray-500 font-normal ml-1">{c.ville}</span>
                    </div>
                    <div className="text-xs whitespace-nowrap">
                      <strong className="text-emerald-700">{c.velosAffilies}</strong>
                      <span className="text-gray-400">/{c.nbVelosCommandes}v</span>
                      {c.reste > 0 && <span className="ml-1 text-amber-700">(+{c.reste})</span>}
                    </div>
                  </div>
                  <div className="w-full h-1 bg-gray-200 rounded mt-1 overflow-hidden">
                    <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="bg-blue-50 border-2 border-blue-300 rounded-lg p-4">
        {selectedClient ? (
          <>
            <div className="text-sm font-bold text-blue-900 mb-2">
              🔫 Scanner un carton pour <strong>{selectedClient.entreprise}</strong>
            </div>
            <div className="text-[11px] text-blue-700 mb-3">
              Reste à affilier : <strong>{selectedClient.reste} vélo{selectedClient.reste > 1 ? "s" : ""}</strong>.
              La scannette tape le FNUCI dans le champ ci-dessous puis Enter automatique.
            </div>
            <form onSubmit={onScannetteSubmit} className="mb-3">
              <input
                ref={scannetteInputRef}
                type="text"
                value={scannetteCode}
                onChange={(e) => setScannetteCode(e.target.value)}
                disabled={scanning}
                autoFocus
                placeholder="Scanner ou taper le FNUCI (BC...) puis Enter"
                className="w-full px-3 py-3 border-2 border-blue-400 rounded-lg text-sm font-mono uppercase focus:border-blue-600 focus:outline-none"
              />
              <button
                type="submit"
                disabled={scanning || !scannetteCode.trim()}
                className="hidden"
              >
                Submit
              </button>
            </form>
            <div className="text-[10px] text-gray-500 italic mb-2 text-center">
              — ou bien si la scannette ne lit pas le sticker —
            </div>
            <label className="block">
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={onScanFile}
                disabled={scanning}
                className="hidden"
              />
              <span className={`block w-full text-center px-4 py-2 rounded-lg text-sm cursor-pointer ${scanning ? "bg-gray-300 text-gray-500" : "bg-white border border-blue-300 text-blue-700 hover:bg-blue-50"}`}>
                {scanning ? "🔍 Identification..." : "📷 Photo Gemini (fallback)"}
              </span>
            </label>
          </>
        ) : (
          <div className="text-sm text-gray-500 italic text-center">
            ⬆️ Sélectionne un client ci-dessus pour activer le scanner
          </div>
        )}
      </div>

      {lastResult && (
        <div className={`border rounded p-3 text-sm ${lastResult.ok ? "bg-emerald-50 border-emerald-300 text-emerald-900" : "bg-red-50 border-red-300 text-red-900"}`}>
          <div>{lastResult.msg}</div>
          {lastResult.ok && lastResult.fnuci && (
            <a
              href={`/etiquettes?fnuci=${encodeURIComponent(lastResult.fnuci)}&copies=2`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block px-3 py-1.5 bg-emerald-600 text-white rounded text-xs font-semibold hover:bg-emerald-700"
            >
              🖨 Imprimer 2 étiquettes (1 sur carton + 1 dedans pour la selle)
            </a>
          )}
        </div>
      )}

      <div className="text-[11px] text-gray-500 italic">
        💡 Workflow : le chef sélectionne un client, scanne un carton, le système identifie le FNUCI via Gemini Vision et affilie + marque préparé. Au montage, les monteurs scannent à nouveau pour valider l étape suivante.
      </div>
    </div>
  );
}
