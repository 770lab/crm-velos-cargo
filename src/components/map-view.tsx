"use client";

import { useEffect } from "react";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Popup,
  Polyline,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

interface ClientPoint {
  id: string;
  entreprise: string;
  ville: string | null;
  departement: string | null;
  lat: number;
  lng: number;
  nbVelos: number;
  velosLivres: number;
  velosPlanifies: number;
  docsComplets: boolean;
}

interface TourneeStop {
  id: string;
  lat: number;
  lng: number;
  entreprise: string;
  nbVelos: number;
}

interface EntrepotPoint {
  id: string;
  nom: string;
  ville: string;
  lat: number;
  lng: number;
  role: "fournisseur" | "stock" | "ephemere";
  isPrimary: boolean;
  archived: boolean;
  stockCartons: number;
  stockVelosMontes: number;
}

interface MapViewProps {
  clients: ClientPoint[];
  selectedId: string | null;
  tourneeIds: Set<string>;
  tournee: TourneeStop[];
  onSelectClient: (id: string) => void;
  entrepots?: EntrepotPoint[];
  hideClients?: boolean;
  selectedEntrepotId?: string | null;
  onSelectEntrepot?: (id: string) => void;
  // Yoann 2026-05-01 — Phase 1.3 : si fournie, polyline encodée Google Maps
  // (Directions API) affichée à la place de la ligne droite vol d oiseau.
  routePolylineEncoded?: string | null;
}

// Décodeur polyline Google (algorithme Polyline Algorithm Format).
// Inline pour éviter une dépendance npm. Cf. developers.google.com/maps/documentation/utilities/polylinealgorithm
function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let b: number;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function getColor(client: ClientPoint, selectedId: string | null, tourneeIds: Set<string>) {
  if (client.id === selectedId) return "#2563eb";
  if (tourneeIds.has(client.id)) return "#16a34a";
  if (client.velosLivres === client.nbVelos && client.nbVelos > 0) return "#9ca3af";
  if (client.docsComplets) return "#f59e0b";
  return "#ef4444";
}

function getRadius(nbVelos: number) {
  if (nbVelos >= 100) return 12;
  if (nbVelos >= 50) return 10;
  if (nbVelos >= 20) return 8;
  if (nbVelos >= 10) return 6;
  return 5;
}

function FitBounds({ clients }: { clients: ClientPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (clients.length > 0) {
      const lats = clients.map((c) => c.lat);
      const lngs = clients.map((c) => c.lng);
      map.fitBounds([
        [Math.min(...lats), Math.min(...lngs)],
        [Math.max(...lats), Math.max(...lngs)],
      ], { padding: [30, 30] });
    }
  }, [clients, map]);
  return null;
}

// Yoann 2026-05-03 — quand le conteneur de la map change de taille
// (ex sélection client → la map se rétrécit pour laisser place à la
// sidebar), Leaflet ne le détecte pas seul et la map reste avec ses
// anciennes dimensions (espace blanc / marker hors écran). On observe
// le conteneur et on appelle invalidateSize à chaque resize.
function InvalidateOnResize() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    if (!container) return;
    const ro = new ResizeObserver(() => {
      map.invalidateSize({ animate: false });
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

export default function MapView({
  clients,
  selectedId,
  tourneeIds,
  tournee,
  onSelectClient,
  entrepots = [],
  hideClients = false,
  selectedEntrepotId = null,
  onSelectEntrepot,
  routePolylineEncoded = null,
}: MapViewProps) {
  // Si polyline Maps fournie → vraie route. Sinon → ligne droite waypoint-to-waypoint.
  const routeLine: [number, number][] = routePolylineEncoded
    ? decodePolyline(routePolylineEncoded)
    : tournee.map((t) => [t.lat, t.lng]);

  return (
    <MapContainer
      center={[46.6, 2.3]}
      zoom={6}
      className="w-full h-full"
      style={{ background: "#f0f0f0" }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitBounds clients={clients} />
      <InvalidateOnResize />

      {routeLine.length > 1 && (
        <Polyline
          positions={routeLine}
          color="#16a34a"
          weight={3}
          opacity={0.7}
          dashArray="8 4"
        />
      )}

      {/* Markers entrepôts (Yoann 2026-05-01). Affichés en plus des
          clients ; en mode "vue entrepôts" hideClients=true ne masque
          que les clients (les entrepôts restent toujours visibles). */}
      {entrepots
        .filter((e) => !e.archived && Number.isFinite(e.lat) && Number.isFinite(e.lng))
        .map((e) => {
          const isSelected = e.id === selectedEntrepotId;
          const totalDispo = e.stockCartons + e.stockVelosMontes;
          const fillColor = e.role === "fournisseur"
            ? "#3b82f6"
            : e.role === "ephemere"
              ? "#a855f7"
              : "#16a34a";
          return (
            <CircleMarker
              key={`ent-${e.id}`}
              center={[e.lat, e.lng]}
              radius={isSelected ? 14 : 11}
              pathOptions={{
                fillColor,
                color: isSelected ? "#1d4ed8" : "#fff",
                weight: isSelected ? 3 : 2,
                fillOpacity: 0.95,
              }}
              eventHandlers={{
                click: (ev) => {
                  // Yoann 2026-05-02 : on stoppe la propagation Leaflet pour
                  // que le click ouvre PROPREMENT le modal (avant : popup
                  // s ouvrait + onSelectEntrepot ne déclenchait pas re-render
                  // visible). On garde l ouverture popup native via openPopup.
                  ev.originalEvent?.stopPropagation?.();
                  onSelectEntrepot?.(e.id);
                },
              }}
            >
              <Popup>
                <div className="text-sm">
                  <div className="font-bold">
                    {e.role === "fournisseur" ? "🏭 " : e.role === "ephemere" ? "🟣 " : "📦 "}
                    {e.nom}
                  </div>
                  <div className="text-gray-600">{e.ville}</div>
                  {e.role === "fournisseur" ? (
                    <div className="text-xs text-gray-500 mt-1 italic">
                      Stock géré chez le fournisseur
                    </div>
                  ) : (
                    <div className="mt-1 text-xs">
                      <span className="text-orange-700">{e.stockCartons} cartons</span>
                      {" · "}
                      <span className="text-emerald-700">{e.stockVelosMontes} montés</span>
                      <span className="text-gray-500"> = {totalDispo} dispo</span>
                    </div>
                  )}
                </div>
              </Popup>
            </CircleMarker>
          );
        })}

      {!hideClients && clients.map((c) => {
        const reste = c.nbVelos - c.velosLivres - c.velosPlanifies;
        const partielPlanifie = c.velosPlanifies > 0 && reste > 0;
        const isSelected = c.id === selectedId;
        const ringColor = isSelected
          ? "#1d4ed8"
          : partielPlanifie
          ? "#f97316"
          : "#fff";
        return (
          <CircleMarker
            key={c.id}
            center={[c.lat, c.lng]}
            radius={getRadius(c.nbVelos)}
            pathOptions={{
              fillColor: getColor(c, selectedId, tourneeIds),
              color: ringColor,
              weight: isSelected ? 3 : partielPlanifie ? 2.5 : 1,
              fillOpacity: 0.85,
            }}
            eventHandlers={{
              click: () => onSelectClient(c.id),
            }}
          >
            <Popup>
              <div className="text-sm">
                <div className="font-bold">{c.entreprise}</div>
                <div className="text-gray-600">
                  {c.ville} ({c.departement})
                </div>
                <div className="mt-1">
                  {c.nbVelos} vélos — {c.velosLivres} livrés
                  {c.velosPlanifies > 0 && (
                    <> — <span className="text-orange-600">{c.velosPlanifies} planifiés</span></>
                  )}
                </div>
                {reste > 0 && (
                  <div className="text-xs text-gray-500">{reste} restant{reste > 1 ? "s" : ""} à planifier</div>
                )}
                <div className="mt-1">
                  Docs: {c.docsComplets ? "complets" : "incomplets"}
                </div>
              </div>
            </Popup>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}
