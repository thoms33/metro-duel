#!/usr/bin/env python3
"""Build the embedded dataset for the metro game.
usage: build_data.py <transit.store> <geo_dir> <out.json>
"""
import json, math, re, sqlite3, sys, collections

STORE, GEO, OUT = sys.argv[1:4]
LON0, LAT0 = 2.3488, 48.8566
KX = 111320 * math.cos(math.radians(LAT0)); KY = 110574
def proj(lon, lat): return ((lon - LON0) * KX, (lat - LAT0) * KY)

# ---------- stations & lines ----------
RENAME = {
 "Gare Saint-Lazare": "Saint-Lazare",
 "Gare Montparnasse": "Montparnasse - Bienvenüe",
 "Saint-Michel Notre-Dame": "Saint-Michel",
 "Péreire Levallois": "Pereire",
 "Saint-Paul (Le Marais)": "Saint-Paul",
 "Pont Marie (Cité des Arts)": "Pont Marie",
 "Rosny Bois Perrier": "Rosny-Bois-Perrier",
 "Aéroport d’Orly (Terminaux 1-2-3)": "Aéroport d'Orly",
 "Thiais - Orly (Pont de Rungis)": "Thiais - Orly",
 "Chevilly-Larue (Marché International)": "Chevilly-Larue",
 "Javel": "Javel - André Citroën",
 "Boulogne Pont de Saint-Cloud": "Boulogne - Pont de Saint-Cloud",
 "Boulogne Jean Jaurès": "Boulogne - Jean Jaurès",
 "Villejuif Léo Lagrange": "Villejuif - Léo Lagrange",
 "Villejuif Paul Vaillant-Couturier": "Villejuif - Paul Vaillant-Couturier",
 "Cour Saint-Emilion": "Cour Saint-Émilion",
 "Château Landon": "Château-Landon",
 "Neuilly - Porte Maillot": "Porte Maillot",
 "Sèvres-Lecourbe": "Sèvres - Lecourbe",
 "Bréguet-Sabin": "Bréguet - Sabin",
}
# extra accepted spellings (besides the automatic ones built in the page)
ALIASES = {
 "Saint-Lazare": ["Gare Saint-Lazare"],
 "Montparnasse - Bienvenüe": ["Montparnasse", "Gare Montparnasse"],
 "Saint-Michel": ["Saint-Michel Notre-Dame"],
 "Pereire": ["Pereire Levallois"],
 "Saint-Paul": ["Saint-Paul Le Marais"],
 "Aéroport d'Orly": ["Orly", "Orly Aéroport"],
 "Thiais - Orly": ["Thiais", "Pont de Rungis"],
 "Javel - André Citroën": ["Javel"],
 "Boulogne - Pont de Saint-Cloud": ["Pont de Saint-Cloud"],
 "Boulogne - Jean Jaurès": ["Jean Jaurès"],
 "Villejuif - Léo Lagrange": ["Léo Lagrange"],
 "Villejuif - Paul Vaillant-Couturier": ["Paul Vaillant-Couturier"],
 "Villejuif - Louis Aragon": ["Louis Aragon"],
 "Villejuif - Gustave Roussy": ["Gustave Roussy"],
 "Porte Maillot": ["Neuilly Porte Maillot"],
 "Charles de Gaulle - Étoile": ["Étoile", "Charles de Gaulle"],
 "Franklin D. Roosevelt": ["Franklin Roosevelt", "Roosevelt", "Franklin Delano Roosevelt"],
 "George V": ["George 5", "Georges V", "Georges 5"],
 "Champs-Élysées - Clemenceau": ["Clemenceau", "Champs-Élysées"],
 "Palais Royal - Musée du Louvre": ["Palais Royal"],
 "La Défense": ["La Défense Grande Arche", "Grande Arche"],
 "La Motte-Picquet - Grenelle": ["La Motte-Picquet", "Motte-Picquet"],
 "Denfert-Rochereau": ["Denfert"],
 "Barbès - Rochechouart": ["Barbès"],
 "Porte de Clignancourt": ["Clignancourt"],
 "Bagneux - Lucie Aubrac": ["Bagneux", "Lucie Aubrac"],
 "Gare d'Austerlitz": ["Austerlitz"],
 "Bobigny - Pablo Picasso": ["Pablo Picasso"],
 "Bobigny - Pantin - Raymond Queneau": ["Raymond Queneau"],
 "Aubervilliers - Pantin - Quatre Chemins": ["Quatre Chemins", "4 Chemins", "Aubervilliers Pantin 4 Chemins"],
 "La Courneuve - 8 Mai 1945": ["La Courneuve", "8 Mai 1945", "La Courneuve Huit Mai 1945"],
 "Quatre Septembre": ["4 Septembre"],
 "Bibliothèque François Mitterrand": ["Bibliothèque", "BFM", "Bibliothèque F. Mitterrand"],
 "Asnières - Gennevilliers - Les Courtilles": ["Les Courtilles", "Asnières Gennevilliers"],
 "Pont de Levallois - Bécon": ["Pont de Levallois"],
 "Basilique de Saint-Denis": ["Saint-Denis Basilique", "Basilique Saint-Denis"],
 "Chaussée d'Antin - La Fayette": ["Chaussée d'Antin", "Chaussée d'Antin Lafayette"],
 "Trinité - d'Estienne d'Orves": ["Trinité", "Trinité Estienne d'Orves"],
 "Lamarck - Caulaincourt": ["Lamarck"],
 "Alma - Marceau": ["Alma"],
 "Cluny - La Sorbonne": ["Cluny"],
 "Maubert - Mutualité": ["Maubert"],
 "Censier - Daubenton": ["Censier"],
 "Place Monge": ["Monge"],
 "Avenue Émile Zola": ["Émile Zola"],
 "École Vétérinaire de Maisons-Alfort": ["École Vétérinaire", "Maisons-Alfort École Vétérinaire"],
 "Maisons-Alfort - Les Juilliottes": ["Les Juilliottes"],
 "Créteil - L'Échat": ["L'Échat"],
 "Le Kremlin-Bicêtre": ["Kremlin-Bicêtre"],
 "Romainville - Carnot": ["Romainville"],
 "Rosny-Bois-Perrier": ["Rosny"],
 "L'Haÿ-les-Roses": ["L'Hay", "Hay les Roses"],
 "Le Peletier": ["Le Pelletier"],
 "Pré-Saint-Gervais": ["Pré Saint-Gervais", "Le Pré-Saint-Gervais"],
 "Saint-Germain-des-Prés": ["Saint-Germain"],
 "Saint-Sébastien - Froissart": ["Saint-Sébastien"],
 "Pierre et Marie Curie": ["Pierre & Marie Curie", "Pierre Curie"],
 "Les Sablons": ["Sablons", "Les Sablons Jardin d'Acclimatation"],
 "Esplanade de la Défense": ["Esplanade"],
 "Hôtel de Ville": ["Hôtel de Ville de Paris"],
 "Mairie de Saint-Ouen": ["Mairie de Saint-Ouen Région Île-de-France"],
 "Buttes Chaumont": ["Les Buttes Chaumont"],
}
c = sqlite3.connect('file:%s?mode=ro' % STORE, uri=True)
def lkey(s):
    m = re.match(r'(\d+)(B?)', s); return (int(m.group(1)), m.group(2))
lines_raw = sorted(c.execute("select ZSOURCEID, ZSHORTNAME, ZCOLOR, ZTEXTCOLOR from ZTRANSITLINE where lower(ZMODE)='metro'").fetchall(), key=lambda r: lkey(r[1]))
st_raw = {r[0]: r[1:] for r in c.execute("select ZSOURCEID, ZNAME, ZLATITUDE, ZLONGITUDE from ZTRANSITSTATION")}

stations = {}   # source id -> dict
order = []
lines = []
for li, (lid, short, color, tcolor) in enumerate(lines_raw):
    vs = c.execute("select ZSOURCEID, ZSTATIONCOUNT from ZTRANSITROUTEVARIANT where ZLINESOURCEID=? order by ZSTATIONCOUNT desc, ZDIRECTION", (lid,)).fetchall()
    seen_st = set(); variants = []
    for vid, _n in vs:
        stops = [r[0] for r in c.execute("select ZSTATIONSOURCEID from ZTRANSITLINESTOP where ZROUTEVARIANTSOURCEID=? order by ZORDER", (vid,))]
        if set(stops) <= seen_st: continue
        seen_st |= set(stops)
        variants.append(stops)
    for stops in variants:
        for s in stops:
            if s not in stations:
                name, lat, lon = st_raw[s]
                name = RENAME.get(name, name)
                stations[s] = {"name": name, "lat": lat, "lon": lon, "lines": []}
                order.append(s)
            if li not in stations[s]["lines"]: stations[s]["lines"].append(li)
    label = short.replace('B', 'bis')
    lines.append({"id": label, "c": "#" + color.lower(), "t": "#" + tcolor.lower(), "v": variants})

names = [stations[s]["name"] for s in order]
assert len(set(names)) == len(names), "duplicate station names"
for k in ALIASES: assert k in names, "alias for unknown station: " + k
idx = {s: i for i, s in enumerate(order)}
out_st = []
for s in order:
    d = stations[s]; x, y = proj(d["lon"], d["lat"])
    out_st.append([d["name"], round(x), round(y), d["lines"], ALIASES.get(d["name"], [])])
out_lines = [{"id": l["id"], "c": l["c"], "t": l["t"], "v": [[idx[s] for s in v] for v in l["v"]]} for l in lines]

# ---------- background: Paris outline + rivers from administrative borders ----------
def rings_of(feature):
    g = feature["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    return [[proj(*pt[:2]) for pt in poly[0]] for poly in polys]
def load(fn): return json.load(open(GEO + "/" + fn))["features"]
def seg_dist(p, a, b):
    ax, ay = a; bx, by = b; px, py = p
    dx, dy = bx-ax, by-ay; L2 = dx*dx+dy*dy
    t = 0 if L2 == 0 else max(0, min(1, ((px-ax)*dx+(py-ay)*dy)/L2))
    return math.hypot(px-(ax+t*dx), py-(ay+t*dy))
def ring_dist(p, ring): return min(seg_dist(p, ring[i], ring[i+1]) for i in range(len(ring)-1))
def densify(ring, step):
    out = []
    for a, b in zip(ring, ring[1:]):
        n = max(1, int(math.hypot(b[0]-a[0], b[1]-a[1]) // step))
        out += [(a[0]+(b[0]-a[0])*k/n, a[1]+(b[1]-a[1])*k/n) for k in range(n)]
    return out
def simplify(pts, tol):
    if len(pts) < 3: return pts
    a, b = pts[0], pts[-1]; dmax, im = 0, 0
    for i in range(1, len(pts)-1):
        d = seg_dist(pts[i], a, b)
        if d > dmax: dmax, im = d, i
    if dmax <= tol: return [a, b]
    return simplify(pts[:im+1], tol)[:-1] + simplify(pts[im:], tol)
def shared(ra, rb, eps):
    runs = []
    for ring in ra:
        pts = densify(ring, 30)
        flags = [min(ring_dist(p, r) for r in rb) < eps for p in pts]
        if all(flags): continue
        n = len(pts); start = next(i for i in range(n) if not flags[i])
        cur = []
        for k in range(n):
            i = (start + k) % n
            if flags[i]: cur.append(pts[i])
            elif cur:
                runs.append(cur); cur = []
        if cur: runs.append(cur)
    return [simplify(r, 12) for r in runs if len(r) >= 4]

arr = {f["properties"]["name"]: rings_of(f) for f in load("paris.geojson")}
com = {}
for fn in ("communes-92-hauts-de-seine.geojson", "communes-93-seine-saint-denis.geojson", "communes-94-val-de-marne.geojson"):
    for f in load(fn): com[f["properties"]["nom"]] = rings_of(f)
paris = rings_of(load("communes-75-paris.geojson")[0])
com["Paris"] = paris

A = {1: "Louvre", 4: "Hôtel-de-Ville", 5: "Panthéon", 6: "Luxembourg", 7: "Palais-Bourbon", 8: "Élysée", 12: "Reuilly", 13: "Gobelins", 15: "Vaugirard", 16: "Passy"}
water = []
for a, b in [(13, 12), (5, 12), (5, 4), (6, 4), (6, 1), (7, 1), (7, 8), (7, 16), (15, 16)]:
    water += shared(arr[A[a]], arr[A[b]], 60)
PAIRS = [
 ("Vitry-sur-Seine", "Alfortville"), ("Ivry-sur-Seine", "Alfortville"), ("Ivry-sur-Seine", "Charenton-le-Pont"),
 ("Issy-les-Moulineaux", "Boulogne-Billancourt"), ("Meudon", "Boulogne-Billancourt"), ("Sèvres", "Boulogne-Billancourt"),
 ("Saint-Cloud", "Boulogne-Billancourt"), ("Saint-Cloud", "Paris"), ("Suresnes", "Paris"), ("Puteaux", "Paris"),
 ("Puteaux", "Neuilly-sur-Seine"), ("Courbevoie", "Neuilly-sur-Seine"), ("Courbevoie", "Levallois-Perret"),
 ("Asnières-sur-Seine", "Levallois-Perret"), ("Asnières-sur-Seine", "Clichy"), ("Asnières-sur-Seine", "Saint-Ouen"),
 ("Gennevilliers", "Saint-Ouen"), ("Île-Saint-Denis", "Saint-Ouen"), ("Île-Saint-Denis", "Saint-Denis"),
 ("Île-Saint-Denis", "Gennevilliers"), ("Île-Saint-Denis", "Villeneuve-la-Garenne"), ("Île-Saint-Denis", "Épinay-sur-Seine"),
 ("Gennevilliers", "Épinay-sur-Seine"),
 # Marne
 ("Charenton-le-Pont", "Alfortville"), ("Charenton-le-Pont", "Maisons-Alfort"), ("Saint-Maurice", "Maisons-Alfort"),
 ("Saint-Maur-des-Fossés", "Créteil"), ("Saint-Maur-des-Fossés", "Maisons-Alfort"),
]
missing = [n for p in PAIRS for n in p if n not in com]
if missing: print("unknown communes:", sorted(set(missing)))
for a, b in PAIRS:
    if a in com and b in com:
        got = shared(com[a], com[b], 40)
        print(f"  {a} | {b}: {len(got)} run(s), {sum(len(r) for r in got)} pts")
        water += got
def chain(runs, tol):
    runs = [list(r) for r in runs]
    while True:
        best = None
        for i in range(len(runs)):
            for j in range(i + 1, len(runs)):
                for ei in (0, -1):
                    for ej in (0, -1):
                        d = math.hypot(runs[i][ei][0] - runs[j][ej][0], runs[i][ei][1] - runs[j][ej][1])
                        if d < tol and (best is None or d < best[0]): best = (d, i, j, ei, ej)
        if not best: return runs
        _, i, j, ei, ej = best
        a = runs[i] if ei == -1 else runs[i][::-1]
        b = runs[j] if ej == 0 else runs[j][::-1]
        runs[i] = a + b; del runs[j]
def clean(pts):
    out = [pts[0]]
    for p in pts[1:]:
        if math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > 60: out.append(p)
    changed = True
    while changed and len(out) > 2:
        changed = False
        for i in range(1, len(out) - 1):
            a, b, c = out[i - 1], out[i], out[i + 1]
            v1 = (b[0] - a[0], b[1] - a[1]); v2 = (c[0] - b[0], c[1] - b[1])
            cos = (v1[0] * v2[0] + v1[1] * v2[1]) / ((math.hypot(*v1) * math.hypot(*v2)) or 1)
            if cos < -0.2:
                del out[i]; changed = True; break
    return out
water = [clean(w) for w in chain(water, 650)]
print("water chains:", [len(w) for w in water])
rnd = lambda pts: [[round(x), round(y)] for x, y in pts]
data = {"st": out_st, "lines": out_lines, "paris": [rnd(simplify(r, 15)) for r in paris], "water": [rnd(w) for w in water]}
json.dump(data, open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
print("stations", len(out_st), "lines", len(out_lines), "line-stops", sum(len(s[3]) for s in out_st), "variants", sum(len(l["v"]) for l in out_lines))
print("paris rings", [len(r) for r in data["paris"]], "water runs", len(water), "bytes", len(json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()))
