#!/usr/bin/env python3
"""
Build the game world from the cached Overture (OpenStreetMap-derived) data.

Input : data/raw/*.parquet            (from tools/fetch_overture.py)
Output: public/world/
          manifest.json               projection, perimeter, chunk index, spawn
          L0/i_j.bin                  1024 m chunks, full detail
          L1/i_j.bin                  4096 m chunks, simplified (mid zoom)
          L2/i_j.bin                  16384 m chunks, major features (far zoom)
          labels/L1_i_j.json          street-label candidates per 4 km chunk
          labels/global.json          neighborhoods, landmarks, parks, shields, major streets
          routing.bin + routing.json  drivable road graph (one-way aware)
          search.json                 streets, places and neighborhoods for search

Every coordinate is in metres in a Transverse Mercator projection centred on
Atlanta (conformal: angles and shapes are preserved; scale error < 0.001 %
inside I-285).  Game y grows southward (screen convention): gy = -northing.
"""
import json, math, os, re, sys, time, collections
import numpy as np
import pyarrow.parquet as pq
import shapely
import shapely.ops
from shapely.geometry import Polygon, LineString, MultiLineString, box, Point
from shapely.strtree import STRtree
from pyproj import Transformer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "public", "world")

LAT0, LON0 = 33.7756, -84.3900
PROJ = f"+proj=tmerc +lat_0={LAT0} +lon_0={LON0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs"
TF = Transformer.from_crs("EPSG:4326", PROJ, always_xy=True)

LODS = {
    0: dict(size=1024, unit=0.1),
    1: dict(size=4096, unit=0.25),
    2: dict(size=16384, unit=1.0),
}

# ---------------------------------------------------------------- codes ----
# (mirrored in src/world/codes.ts)
LK = dict(motorway=0, trunk=1, primary=2, secondary=3, tertiary=4, residential=5,
          minor=6, service=7, service_minor=8, road_unknown=9, pedestrian=10,
          path=11, sidewalk=12, rail=13, metro=14, tram=15, stream=16, river=17,
          ditch=18, water_edge=19)
LF = dict(link=1, bridge=2, tunnel=4, oneway=8, oneway_rev=16, construction=32, private=64)
PK = dict(residential=0, commercial=1, retail=2, industrial=3, park=4, grass=5, forest=6,
          shrub=7, garden=8, cemetery=9, golf=10, fairway=11, green=12, sand=13, pitch=14,
          track=15, playground=16, stadium=17, school=18, university=19, hospital=20,
          parking=21, plaza=22, construction=23, railway=24, water=25, pool=26,
          religious=27, nature=28, recreation=29, dogpark=30, farm=31, bridge_deck=32)

ROAD_CLASS = {
    "motorway": "motorway", "trunk": "trunk", "primary": "primary", "secondary": "secondary",
    "tertiary": "tertiary", "residential": "residential", "unclassified": "minor",
    "living_street": "minor", "service": "service", "unknown": "road_unknown",
    "pedestrian": "pedestrian", "footway": "path", "path": "path", "cycleway": "path",
    "steps": "path", "track": "service_minor", "bridleway": "path",
}
DRIVABLE_KINDS = {LK[k] for k in ("motorway", "trunk", "primary", "secondary", "tertiary",
                                  "residential", "minor", "service", "service_minor", "road_unknown")}

# ------------------------------------------------------------ helpers ------

def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


def proj_coords(c):
    x, y = TF.transform(c[:, 0], c[:, 1])
    return np.column_stack([x, -np.asarray(y)])


def load(name, cols=None):
    t = pq.read_table(os.path.join(RAW, f"{name}.parquet"), columns=cols)
    geoms = shapely.from_wkb(t.column("geometry").to_numpy(zero_copy_only=False))
    geoms = shapely.transform(geoms, proj_coords)
    return t, geoms


def name_of(n):
    if not n:
        return None
    p = n.get("primary")
    return p.strip() if p else None


def ranges_split(between_lists):
    """collect all breakpoints (normalized 0..1) from a list of `between` arrays"""
    pts = {0.0, 1.0}
    for b in between_lists:
        if b:
            pts.add(max(0.0, min(1.0, b[0])))
            pts.add(max(0.0, min(1.0, b[1])))
    return sorted(pts)


def covers(between, a, b):
    if not between:
        return True
    m = (a + b) / 2
    return between[0] <= m <= between[1]


# ------------------------------------------------------------ perimeter ----

def build_perimeter(seg_t, seg_g):
    log("building I-285 perimeter from interstate geometry")
    cls = seg_t.column("class").to_pylist()
    sub = seg_t.column("subclass").to_pylist()
    routes = seg_t.column("routes").to_pylist()
    pts = []
    for i, (c, s, r) in enumerate(zip(cls, sub, routes)):
        if c != "motorway" or s == "link" or not r:
            continue
        if any(x.get("network") == "US:I" and x.get("ref") == "285" for x in r):
            pts.append(shapely.get_coordinates(seg_g[i]))
    pts = np.vstack(pts)
    # densify-free approach: the interstate is star-shaped about its centroid,
    # so take the outermost carriageway point in every angular bin.
    cx, cy = pts.mean(axis=0)
    ang = np.arctan2(pts[:, 1] - cy, pts[:, 0] - cx)
    rad = np.hypot(pts[:, 0] - cx, pts[:, 1] - cy)
    NB = 2048
    bins = ((ang + math.pi) / (2 * math.pi) * NB).astype(int) % NB
    rmax = np.full(NB, np.nan)
    for b, r in zip(bins, rad):
        if np.isnan(rmax[b]) or r > rmax[b]:
            rmax[b] = r
    # fill empty bins by circular interpolation
    idx = np.arange(NB)
    good = ~np.isnan(rmax)
    rmax = np.interp(idx, np.concatenate([idx[good] - NB, idx[good], idx[good] + NB]),
                     np.concatenate([rmax[good]] * 3))
    th = (idx + 0.5) / NB * 2 * math.pi - math.pi
    ring = np.column_stack([cx + rmax * np.cos(th), cy + rmax * np.sin(th)])
    poly = Polygon(ring).buffer(0)
    poly = poly.simplify(5)
    log(f"  perimeter: {len(pts)} interstate vertices, area {poly.area/1e6:.1f} km^2")
    return poly


# ------------------------------------------------------------ chunk store --

class Store:
    def __init__(self):
        self.chunks = collections.defaultdict(lambda: dict(lines=[], polys=[], blds=[], names={}, refs={}))

    @staticmethod
    def key_range(lod, bounds):
        s = LODS[lod]["size"]
        x0, y0, x1, y1 = bounds
        return (int(math.floor(x0 / s)), int(math.floor(y0 / s)),
                int(math.floor(x1 / s)), int(math.floor(y1 / s)))

    def _sid(self, ch, table, s):
        if s is None:
            return -1
        t = ch[table]
        if s not in t:
            t[s] = len(t)
        return t[s]

    def add_line(self, lod, geom, kind, flags=0, level=0, name=None, ref=None):
        if geom.is_empty:
            return
        s = LODS[lod]["size"]
        i0, j0, i1, j1 = self.key_range(lod, geom.bounds)
        for i in range(i0, i1 + 1):
            for j in range(j0, j1 + 1):
                g = geom
                if (i0, j0) != (i1, j1):
                    g = shapely.clip_by_rect(geom, i * s, j * s, (i + 1) * s, (j + 1) * s)
                    if g.is_empty:
                        continue
                ch = self.chunks[(lod, i, j)]
                nid = self._sid(ch, "names", name)
                rid = self._sid(ch, "refs", ref)
                for part in getattr(g, "geoms", [g]):
                    if part.geom_type != "LineString":
                        continue
                    c = shapely.get_coordinates(part)
                    if len(c) >= 2:
                        ch["lines"].append((kind, flags, level, nid, rid, c))

    def add_poly(self, lod, geom, kind, outline_kind=None):
        """large polygons are clipped to chunks; small ones go to the chunk of their centre"""
        if geom.is_empty:
            return
        s = LODS[lod]["size"]
        x0, y0, x1, y1 = geom.bounds
        if max(x1 - x0, y1 - y0) <= 500:
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            key = (lod, int(math.floor(cx / s)), int(math.floor(cy / s)))
            self._push_poly(key, geom, kind)
            if outline_kind is not None:
                self.add_line(lod, geom.boundary, outline_kind)
            return
        i0, j0, i1, j1 = self.key_range(lod, geom.bounds)
        for i in range(i0, i1 + 1):
            for j in range(j0, j1 + 1):
                g = shapely.clip_by_rect(geom, i * s, j * s, (i + 1) * s, (j + 1) * s)
                if g.is_empty:
                    continue
                self._push_poly((lod, i, j), g, kind)
        if outline_kind is not None:
            self.add_line(lod, geom.boundary, outline_kind)

    def _push_poly(self, key, g, kind):
        ch = self.chunks[key]
        for part in getattr(g, "geoms", [g]):
            if part.geom_type != "Polygon" or part.is_empty:
                continue
            rings = [shapely.get_coordinates(part.exterior)] + \
                    [shapely.get_coordinates(r) for r in part.interiors]
            rings = [r[:-1] for r in rings if len(r) >= 4]
            if rings:
                ch["polys"].append((kind, rings))

    def add_building(self, lod, geom, h, flags):
        s = LODS[lod]["size"]
        x0, y0, x1, y1 = geom.bounds
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        key = (lod, int(math.floor(cx / s)), int(math.floor(cy / s)))
        ch = self.chunks[key]
        for part in getattr(geom, "geoms", [geom]):
            if part.geom_type != "Polygon" or part.is_empty:
                continue
            rings = [shapely.get_coordinates(part.exterior)] + \
                    [shapely.get_coordinates(r) for r in part.interiors]
            rings = [r[:-1] for r in rings if len(r) >= 4]
            if rings:
                ch["blds"].append((h, flags, rings))

    def write(self):
        index = {0: [], 1: [], 2: []}
        total = collections.Counter()
        for (lod, i, j), ch in sorted(self.chunks.items()):
            s, unit = LODS[lod]["size"], LODS[lod]["unit"]
            ox, oy = (i + 0.5) * s, (j + 0.5) * s
            pts = []
            npts = 0

            def q(c):
                nonlocal npts
                a = np.round((c - [ox, oy]) / unit)
                if np.abs(a).max() > 32767:
                    a = np.clip(a, -32767, 32767)
                pts.append(a.astype(np.int16))
                o = npts
                npts += len(c)
                return o, len(c)

            # draw order: sort lines so that within a chunk thin things come first (renderer re-sorts anyway)
            Lk, Lf, Ll, Ln, Lr, Lo, Lc = [], [], [], [], [], [], []
            for kind, flags, level, nid, rid, c in ch["lines"]:
                o, n = q(c)
                Lk.append(kind); Lf.append(flags); Ll.append(level); Ln.append(nid); Lr.append(rid); Lo.append(o); Lc.append(n)
            Ro, Rc = [], []
            Pk, Po, Pc = [], [], []
            for kind, rings in ch["polys"]:
                Pk.append(kind); Po.append(len(Ro)); Pc.append(len(rings))
                for r in rings:
                    o, n = q(r); Ro.append(o); Rc.append(n)
            Bh, Bf, Bo, Bc = [], [], [], []
            for h, flags, rings in ch["blds"]:
                Bh.append(h); Bf.append(flags); Bo.append(len(Ro)); Bc.append(len(rings))
                for r in rings:
                    o, n = q(r); Ro.append(o); Rc.append(n)
            arrays = [
                ("Lk", np.array(Lk, np.uint8)), ("Lf", np.array(Lf, np.uint8)), ("Ll", np.array(Ll, np.int8)),
                ("Ln", np.array(Ln, np.int32)), ("Lr", np.array(Lr, np.int32)),
                ("Lo", np.array(Lo, np.uint32)), ("Lc", np.array(Lc, np.uint32)),
                ("Pk", np.array(Pk, np.uint8)), ("Po", np.array(Po, np.uint32)), ("Pc", np.array(Pc, np.uint32)),
                ("Bh", np.array(Bh, np.uint8)), ("Bf", np.array(Bf, np.uint8)),
                ("Bo", np.array(Bo, np.uint32)), ("Bc", np.array(Bc, np.uint32)),
                ("Ro", np.array(Ro, np.uint32)), ("Rc", np.array(Rc, np.uint32)),
                ("P", np.concatenate(pts).reshape(-1) if pts else np.zeros(0, np.int16)),
            ]
            names = [k for k, _ in sorted(ch["names"].items(), key=lambda kv: kv[1])]
            refs = [k for k, _ in sorted(ch["refs"].items(), key=lambda kv: kv[1])]
            path = os.path.join(OUT, f"L{lod}", f"{i}_{j}.bin")
            write_container(path, dict(lod=lod, i=i, j=j, ox=ox, oy=oy, unit=unit, names=names, refs=refs), arrays)
            index[lod].append([i, j])
            total[lod] += os.path.getsize(path)
        for lod in index:
            log(f"  L{lod}: {len(index[lod])} chunks, {total[lod]/1e6:.1f} MB")
        return index


def write_container(path, header, arrays):
    """[u32 magic 'ATLW'][u32 header length][header json][pad to 8][arrays...]"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    offs = {}
    body = bytearray()
    for name, a in arrays:
        while len(body) % 8:
            body.append(0)
        offs[name] = [a.dtype.str.lstrip("<|"), len(body), int(a.size)]
        body += a.astype(a.dtype.newbyteorder("<")).tobytes()
    header = dict(header, arrays=offs)
    hj = json.dumps(header, separators=(",", ":")).encode()
    pad = (8 - (8 + len(hj)) % 8) % 8
    hj += b" " * pad
    with open(path, "wb") as f:
        f.write(b"ATLW")
        f.write(len(hj).to_bytes(4, "little"))
        f.write(hj)
        f.write(body)


# ------------------------------------------------------------ roads --------

def access_info(acc):
    oneway = 0
    no_motor = False
    private = False
    for a in acc or []:
        w = a.get("when") or {}
        modes = w.get("mode")
        heading = w.get("heading")
        if a["access_type"] == "denied":
            if heading and not modes and not w.get("using") and not w.get("vehicle") and not w.get("during") and not a.get("between"):
                oneway = LF["oneway"] if heading == "backward" else LF["oneway_rev"]
            elif not heading and (not modes or "motor_vehicle" in modes or "car" in modes) and not w.get("vehicle") and not w.get("using") and not w.get("during"):
                no_motor = True
        elif a["access_type"] == "allowed":
            rec = w.get("recognized") or []
            if "as_private" in rec:
                private = True
    return oneway, no_motor, private


def route_refs(routes):
    out = []
    for r in routes or []:
        net, ref = r.get("network"), r.get("ref")
        if not ref:
            continue
        if net == "US:I":
            out.append(f"I:{ref}")
        elif net == "US:US":
            out.append(f"US:{ref}")
        elif net == "US:GA":
            out.append(f"GA:{ref}")
    # stable, unique
    seen = []
    for x in out:
        if x not in seen:
            seen.append(x)
    return ";".join(seen) if seen else None


def process_roads(store, seg_t, seg_g, region, conn_pos):
    log("processing road & rail segments")
    cols = {c: seg_t.column(c).to_pylist() for c in
            ["id", "names", "subtype", "class", "subclass", "road_flags", "rail_flags", "level_rules",
             "access_restrictions", "routes", "connectors"]}
    inside = shapely.intersects(region, seg_g)
    region_p = region
    shapely.prepare(region_p)
    within = shapely.within(seg_g, region_p)

    label_pieces = collections.defaultdict(list)  # (name, rank) -> [LineString]
    shield_pieces = collections.defaultdict(list)  # ref -> [LineString]
    routing = []  # drivable segments for the graph
    drivable_lines = []
    n = len(seg_g)
    for k in range(n):
        if not inside[k]:
            continue
        g = seg_g[k]
        st, cl, sc = cols["subtype"][k], cols["class"][k], cols["subclass"][k]
        name = name_of(cols["names"][k])
        if st == "rail":
            kind = {"subway": LK["metro"], "light_rail": LK["metro"], "monorail": LK["metro"],
                    "tram": LK["tram"]}.get(cl, LK["rail"])
            flagsets = cols["rail_flags"][k]
        else:
            rc = ROAD_CLASS.get(cl, "road_unknown")
            if cl == "footway" and sc in ("sidewalk", "crosswalk"):
                rc = "sidewalk"
            if cl == "cycleway" and sc == "cycle_crossing":
                rc = "sidewalk"
            if cl == "service" and sc in ("driveway", "parking_aisle", "alley"):
                rc = "service_minor"
            kind = LK[rc]
            flagsets = cols["road_flags"][k]
        base_flags = 0
        if sc == "link":
            base_flags |= LF["link"]
        oneway, no_motor, private = access_info(cols["access_restrictions"][k])
        if st == "road":
            base_flags |= oneway
            if private:
                base_flags |= LF["private"]
        levels = cols["level_rules"][k] or []
        flags = flagsets or []
        if any("is_under_construction" in (f["values"] or []) for f in flags):
            base_flags |= LF["construction"]
        if any("is_abandoned" in (f["values"] or []) for f in flags) and st == "rail":
            continue
        refs = route_refs(cols["routes"][k]) if kind in (LK["motorway"], LK["trunk"], LK["primary"]) else None

        # split by level / bridge / tunnel ranges
        bps = ranges_split([x.get("between") for x in levels] + [f.get("between") for f in flags])
        gl = g if within[k] else shapely.intersection(g, region_p)
        pieces = []
        for a, b in zip(bps[:-1], bps[1:]):
            if b - a < 1e-6:
                continue
            lvl = 0
            for x in levels:
                if covers(x.get("between"), a, b):
                    lvl = x["value"]
            fl = base_flags
            for f in flags:
                if covers(f.get("between"), a, b):
                    vals = f["values"] or []
                    if "is_bridge" in vals:
                        fl |= LF["bridge"]
                    if "is_tunnel" in vals:
                        fl |= LF["tunnel"]
                    if "is_link" in vals:
                        fl |= LF["link"]
            if len(bps) == 2:
                piece = g
            else:
                piece = shapely.ops.substring(g, a, b, normalized=True)
            if not within[k]:
                piece = shapely.intersection(piece, region_p)
            if piece.is_empty:
                continue
            if fl & LF["bridge"] and lvl == 0:
                lvl = 1
            if fl & LF["tunnel"] and lvl == 0:
                lvl = -1
            pieces.append((piece, fl, max(-3, min(5, lvl))))
        for piece, fl, lvl in pieces:
            if st == "rail" and fl & LF["tunnel"]:
                continue
            store.add_line(0, piece, kind, fl, lvl, name, refs)
            if kind <= LK["service"] or kind == LK["metro"] or kind == LK["rail"] or kind == LK["tram"] or kind == LK["pedestrian"]:
                store.add_line(1, piece.simplify(1.0), kind, fl, lvl, name, refs)
            if kind <= LK["minor"] or kind == LK["rail"] or kind == LK["metro"]:
                store.add_line(2, piece.simplify(4.0), kind, fl, lvl, name, refs)
        # labels
        if name and st == "road" and kind not in (LK["sidewalk"],):
            rank = {0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 5, 7: 6, 8: 7, 9: 6, 10: 6, 11: 6}.get(kind, 7)
            if base_flags & LF["link"]:
                rank = 7
            label_pieces[(name, rank)].append(gl)
        if refs and kind in (LK["motorway"], LK["trunk"]) and not (base_flags & LF["link"]):
            shield_pieces[refs].append(gl)
        # routing
        if st == "road" and kind in DRIVABLE_KINDS and not no_motor and not (base_flags & LF["construction"]) \
                and not (sc in ("driveway", "parking_aisle")) and not private and kind != LK["road_unknown"]:
            routing.append((cols["id"][k], g, kind, base_flags, name, cols["connectors"][k] or []))
        if st == "road" and kind in DRIVABLE_KINDS and not no_motor:
            drivable_lines.append(g)
    log(f"  {len(routing)} routable segments, {len(label_pieces)} label groups")
    return label_pieces, shield_pieces, routing, drivable_lines


# ------------------------------------------------------------ routing ------

SPEED = {0: 29.0, 1: 22.0, 2: 17.0, 3: 15.0, 4: 13.0, 5: 11.0, 6: 10.0, 7: 7.0, 8: 5.0, 9: 6.0}


def build_routing(routing):
    log("building routing graph")
    node_id = {}
    nx, ny = [], []
    E = collections.defaultdict(list)

    def nid(cid, pt):
        if cid not in node_id:
            node_id[cid] = len(nx)
            nx.append(pt[0]); ny.append(pt[1])
        return node_id[cid]

    ea, eb, elen, ecls, efl, ename, ego, egc = [], [], [], [], [], [], [], []
    gpts = []
    gcount = 0
    names = {}
    for sid, g, kind, flags, name, conns in routing:
        conns = sorted(conns, key=lambda c: c["at"])
        if len(conns) < 2:
            continue
        L = g.length
        for c0, c1 in zip(conns[:-1], conns[1:]):
            a, b = c0["at"], c1["at"]
            if b - a <= 1e-9:
                continue
            sub = shapely.ops.substring(g, a, b, normalized=True)
            if sub.is_empty or sub.geom_type != "LineString":
                continue
            c = shapely.get_coordinates(sub.simplify(0.75))
            na = nid(c0["connector_id"], c[0])
            nb = nid(c1["connector_id"], c[-1])
            if na == nb:
                continue
            ea.append(na); eb.append(nb); elen.append(sub.length)
            ecls.append(kind); efl.append(flags)
            if name not in names:
                names[name] = len(names)
            ename.append(names[name] if name else -1)
            ego.append(gcount); egc.append(len(c))
            gpts.append(c.astype(np.float32)); gcount += len(c)
    nN, nE = len(nx), len(ea)
    # drop tiny disconnected islands (private lots etc.)
    parent = list(range(nN))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for a, b in zip(ea, eb):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    comp = collections.Counter(find(i) for i in range(nN))
    big = comp.most_common(1)[0][0]
    keep_node = np.array([find(i) == big for i in range(nN)])
    log(f"  graph: {nN} nodes, {nE} edges; main component {comp[big]} nodes ({len(comp)} components)")
    keep = np.array([keep_node[a] and keep_node[b] for a, b in zip(ea, eb)])
    # remap nodes
    newid = -np.ones(nN, np.int64)
    kn = np.nonzero(keep_node)[0]
    newid[kn] = np.arange(len(kn))
    nxa, nya = np.array(nx)[kn], np.array(ny)[kn]
    sel = np.nonzero(keep)[0]
    G = np.concatenate([gpts[i] for i in sel]).reshape(-1)
    go2 = np.cumsum([0] + [egc[i] for i in sel[:-1]])
    arrays = [
        ("nx", nxa.astype(np.float32)), ("ny", nya.astype(np.float32)),
        ("ea", newid[np.array(ea)[sel]].astype(np.uint32)), ("eb", newid[np.array(eb)[sel]].astype(np.uint32)),
        ("el", np.array(elen, np.float32)[sel]), ("ec", np.array(ecls, np.uint8)[sel]),
        ("ef", np.array(efl, np.uint8)[sel]), ("en", np.array(ename, np.int32)[sel]),
        ("go", np.array(go2, np.uint32)), ("gc", np.array(egc, np.uint32)[sel]),
        ("G", G.astype(np.float32)),
    ]
    nm = [k for k, _ in sorted(names.items(), key=lambda kv: kv[1])]
    write_container(os.path.join(OUT, "routing.bin"), dict(names=nm), arrays)
    log(f"  routing.bin {os.path.getsize(os.path.join(OUT, 'routing.bin'))/1e6:.1f} MB, {len(sel)} edges")


# ------------------------------------------------------------ labels -------

def label_candidates(label_pieces):
    log("placing street-label candidates")
    per_chunk = collections.defaultdict(lambda: dict(names={}, c=[]))
    global_c = dict(names={}, c=[])
    search_streets = []
    S1 = LODS[1]["size"]
    for (name, rank), parts in label_pieces.items():
        merged = shapely.line_merge(shapely.union_all(parts)) if len(parts) > 1 else parts[0]
        lines = [p for p in getattr(merged, "geoms", [merged]) if p.geom_type == "LineString"]
        spacing = [900, 900, 700, 600, 500, 380, 300, 260][rank]
        centers = []
        for ln in lines:
            L = ln.length
            if L < 40:
                continue
            centers.append(ln.interpolate(0.5, normalized=True))
            nlab = max(1, int(L // spacing))
            for t in range(nlab):
                d = (t + 0.5) * L / nlab
                a, b = max(0, d - 160), min(L, d + 160)
                sub = shapely.ops.substring(ln, a, b)
                if sub.geom_type != "LineString":
                    continue
                c = np.round(shapely.get_coordinates(sub.simplify(0.8)), 1)
                mid = ln.interpolate(d)
                flat = c.reshape(-1).tolist()
                key = (int(math.floor(mid.x / S1)), int(math.floor(mid.y / S1)))
                tgt = per_chunk[key]
                if name not in tgt["names"]:
                    tgt["names"][name] = len(tgt["names"])
                tgt["c"].append([tgt["names"][name], rank, flat])
                if rank <= 3:
                    if name not in global_c["names"]:
                        global_c["names"][name] = len(global_c["names"])
                    global_c["c"].append([global_c["names"][name], rank, flat])
        # search entries: cluster chain centres
        pts = []
        for p in centers:
            if all(math.hypot(p.x - q[0], p.y - q[1]) > 600 for q in pts):
                pts.append((round(p.x, 1), round(p.y, 1)))
        for q in pts:
            search_streets.append((name, rank, q))
    os.makedirs(os.path.join(OUT, "labels"), exist_ok=True)
    for (i, j), d in per_chunk.items():
        names = [k for k, _ in sorted(d["names"].items(), key=lambda kv: kv[1])]
        with open(os.path.join(OUT, "labels", f"L1_{i}_{j}.json"), "w") as f:
            json.dump(dict(names=names, c=d["c"]), f, separators=(",", ":"))
    gnames = [k for k, _ in sorted(global_c["names"].items(), key=lambda kv: kv[1])]
    return per_chunk.keys(), dict(names=gnames, c=global_c["c"]), search_streets


def shield_candidates(shield_pieces):
    out = []
    for ref, parts in shield_pieces.items():
        merged = shapely.line_merge(shapely.union_all(parts))
        for ln in getattr(merged, "geoms", [merged]):
            if ln.geom_type != "LineString" or ln.length < 300:
                continue
            n = max(1, int(ln.length // 2200))
            for t in range(n):
                p = ln.interpolate((t + 0.5) / n, normalized=True)
                if all(math.hypot(p.x - o[1], p.y - o[2]) > 900 for o in out if o[0] == ref):
                    out.append([ref, round(p.x, 1), round(p.y, 1)])
    return out


# ------------------------------------------------------------ areas --------

LANDUSE_MAP = {
    ("residential", "residential"): "residential",
    ("developed", "commercial"): "commercial", ("developed", "retail"): "retail",
    ("developed", "industrial"): "industrial", ("developed", "works"): "industrial",
    ("developed", "brownfield"): "construction", ("construction", "construction"): "construction",
    ("construction", "greenfield"): "construction",
    ("park", "park"): "park", ("park", "dog_park"): "dogpark",
    ("managed", "grass"): "grass", ("agriculture", "meadow"): "grass", ("managed", "village_green"): "grass",
    ("horticulture", "garden"): "garden", ("horticulture", "flowerbed"): "garden",
    ("cemetery", "cemetery"): "cemetery", ("cemetery", "grave_yard"): "cemetery",
    ("golf", "golf_course"): "golf", ("golf", "fairway"): "fairway", ("golf", "tee"): "fairway",
    ("golf", "rough"): "golf", ("golf", "driving_range"): "fairway", ("golf", "green"): "green",
    ("golf", "bunker"): "sand", ("golf", "water_hazard"): "water",
    ("recreation", "pitch"): "pitch", ("recreation", "track"): "track",
    ("recreation", "playground"): "playground", ("recreation", "stadium"): "stadium",
    ("recreation", "recreation_ground"): "recreation", ("recreation", "sports_centre"): "recreation",
    ("education", "school"): "school", ("education", "kindergarten"): "school",
    ("education", "university"): "university", ("education", "college"): "university",
    ("medical", "hospital"): "hospital", ("pedestrian", "pedestrian"): "plaza",
    ("pedestrian", "plaza"): "plaza", ("transportation", "railway"): "railway",
    ("religious", "religious"): "religious", ("protected", "nature_reserve"): "nature",
    ("agriculture", "farmland"): "farm", ("park", "nature_reserve"): "nature",
}
# draw order (low first)
PK_ORDER = [PK[k] for k in ["residential", "commercial", "retail", "industrial", "railway", "construction",
                            "school", "university", "hospital", "religious", "farm", "recreation", "park",
                            "nature", "dogpark", "cemetery", "golf", "grass", "forest", "shrub",
                            "garden", "fairway", "green", "sand", "pitch", "track", "playground", "stadium",
                            "plaza", "parking", "water", "pool"]]


def process_areas(store, region, global_labels):
    log("processing land use, land cover, water, parking")
    named_areas = []

    def add(g, kind, lods=(0, 1, 2), outline=None, min_area=(0, 150, 4000)):
        if g.is_empty or not g.is_valid:
            g = g.buffer(0)
        if g.is_empty:
            return
        g = g.intersection(region) if not region.contains(g) else g
        if g.is_empty:
            return
        a = g.area
        for lod in lods:
            if a < min_area[lod]:
                continue
            gg = g if lod == 0 else g.simplify([0, 1.5, 6.0][lod])
            if gg.is_empty:
                continue
            store.add_poly(lod, gg, kind, outline if lod < 2 else None)

    # land cover (ESA WorldCover based) — highest detail zoom band only
    t, gs = load("land_cover")
    sub = t.column("subtype").to_pylist()
    carto = t.column("cartography").to_pylist()
    maxz = max((c or {}).get("max_zoom") or 0 for c in carto)
    hi = [(c or {}).get("max_zoom") == maxz for c in carto]
    lc_kind = {"forest": "forest", "shrub": "shrub"}
    for g, s, h in zip(gs, sub, hi):
        if h and s in lc_kind:
            add(g, PK[lc_kind[s]], min_area=(400, 2000, 20000))

    t, gs = load("land_use")
    sub, cls = t.column("subtype").to_pylist(), t.column("class").to_pylist()
    names = t.column("names").to_pylist()
    for g, s, c, nm in zip(gs, sub, cls, names):
        k = LANDUSE_MAP.get((s, c))
        if not k or g.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        if not shapely.intersects(region, g):
            continue
        add(g, PK[k], outline=None)
        n = name_of(nm)
        if n and k in ("park", "golf", "cemetery", "university", "stadium", "nature", "recreation") and g.area > 6000:
            p = g.representative_point() if not region.contains(g) else g.point_on_surface()
            if region.contains(p):
                named_areas.append(dict(n=n, k=k, x=round(p.x, 1), y=round(p.y, 1), a=round(g.area)))

    t, gs = load("water")
    cls = t.column("class").to_pylist()
    names = t.column("names").to_pylist()
    for g, c, nm in zip(gs, cls, names):
        if not shapely.intersects(region, g):
            continue
        gt = g.geom_type
        if gt in ("Polygon", "MultiPolygon"):
            add(g, PK["pool"] if c == "swimming_pool" else PK["water"],
                outline=LK["water_edge"] if c != "swimming_pool" else None, min_area=(0, 60, 3000))
            n = name_of(nm)
            if n and g.area > 8000 and c != "swimming_pool":
                p = g.point_on_surface()
                if region.contains(p):
                    named_areas.append(dict(n=n, k="water", x=round(p.x, 1), y=round(p.y, 1), a=round(g.area)))
        elif gt in ("LineString", "MultiLineString"):
            kind = {"river": LK["river"], "stream": LK["stream"]}.get(c, LK["ditch"])
            g = g.intersection(region)
            store.add_line(0, g, kind, 0, 0, name_of(nm))
            store.add_line(1, g.simplify(1.5), kind, 0, 0, name_of(nm))
            if kind == LK["river"]:
                store.add_line(2, g.simplify(5), kind)

    t, gs = load("infrastructure", ["geometry", "class", "subtype"])
    cls = t.column("class").to_pylist()
    for g, c in zip(gs, cls):
        if c == "parking" and g.geom_type in ("Polygon", "MultiPolygon") and shapely.intersects(region, g):
            add(g, PK["parking"], lods=(0, 1), min_area=(0, 400, 0))
    global_labels["areas"] = named_areas
    log(f"  {len(named_areas)} named areas")


# ------------------------------------------------------------ buildings ----

def process_buildings(store, region, drivable_lines):
    log("processing buildings")
    t, gs = load("building", ["geometry", "height", "num_floors", "class", "min_height", "is_underground", "names", "level"])
    h = t.column("height").to_pylist()
    nf = t.column("num_floors").to_pylist()
    cl = t.column("class").to_pylist()
    mh = t.column("min_height").to_pylist()
    ug = t.column("is_underground").to_pylist()
    shapely.prepare(region)
    cent = shapely.centroid(gs)
    ins = shapely.contains(region, cent)
    tree = STRtree(drivable_lines)
    # buildings that sit over drivable roads (passages, canopies) are not solid
    cand = np.nonzero(ins)[0]
    q = tree.query(gs[cand], predicate="intersects")
    over_road = set(cand[q[0]].tolist())
    cnt = collections.Counter()
    for k in cand:
        if ug[k]:
            continue
        g = gs[k]
        if not g.is_valid:
            g = g.buffer(0)
        H = h[k] if h[k] else ((nf[k] * 3.4) if nf[k] else 5.0)
        H = max(2.0, min(250.0, H))
        hq = int(round(H))
        solid = 1
        if k in over_road or (mh[k] and mh[k] > 1.5) or cl[k] in ("roof", "carport"):
            solid = 0
        store.add_building(0, g, hq, solid)
        a = g.area
        if a >= 30:
            store.add_building(1, g.simplify(0.8), hq, solid)
        cnt["solid" if solid else "passable"] += 1
    log(f"  buildings: {dict(cnt)}")


# ------------------------------------------------------------ places -------

LANDMARKS = [
    # (name as in Overture places, short label, kind)
    ("Mercedes-Benz Stadium", "Mercedes-Benz Stadium", "stadium"),
    ("State Farm Arena", "State Farm Arena", "stadium"),
    ("Georgia Aquarium", "Georgia Aquarium", "attraction"),
    ("World of Coca-Cola", "World of Coca-Cola", "attraction"),
    ("Centennial Olympic Park", "Centennial Olympic Park", "park"),
    ("Fox Theatre", "Fox Theatre", "attraction"),
    ("Ponce City Market", "Ponce City Market", "attraction"),
    ("Krog Street Market", "Krog Street Market", "attraction"),
    ("Georgia State Capitol", "Georgia State Capitol", "civic"),
    ("Oakland Cemetery", "Oakland Cemetery", "park"),
    ("Zoo Atlanta", "Zoo Atlanta", "attraction"),
    ("The Varsity", "The Varsity", "food"),
    ("Bank of America Plaza", "Bank of America Plaza", "tower"),
    ("High Museum of Art", "High Museum of Art", "museum"),
    ("Atlanta Botanical Garden", "Atlanta Botanical Garden", "park"),
    ("Center for Civil and Human Rights", "Center for Civil & Human Rights", "museum"),
    ("National Center for Civil and Human Rights", "Center for Civil & Human Rights", "museum"),
    ("Martin Luther King Jr. National Historical Park", "MLK Jr. National Historical Park", "museum"),
    ("Jimmy Carter Presidential Library and Museum", "Carter Presidential Library", "museum"),
    ("Fernbank Museum of Natural History", "Fernbank Museum", "museum"),
    ("Atlanta History Center", "Atlanta History Center", "museum"),
    ("Georgia Institute of Technology", "Georgia Tech", "university"),
    ("Emory University", "Emory University", "university"),
    ("Georgia State University", "Georgia State University", "university"),
    ("Morehouse College", "Morehouse College", "university"),
    ("Spelman College", "Spelman College", "university"),
    ("Clark Atlanta University", "Clark Atlanta University", "university"),
    ("Agnes Scott College", "Agnes Scott College", "university"),
    ("Bobby Dodd Stadium", "Bobby Dodd Stadium", "stadium"),
    ("Center Parc Stadium", "Center Parc Stadium", "stadium"),
    ("Lenox Square", "Lenox Square", "attraction"),
    ("Phipps Plaza", "Phipps Plaza", "attraction"),
    ("Atlantic Station", "Atlantic Station", "attraction"),
    ("Hartsfield-Jackson Atlanta International Airport", "Hartsfield–Jackson Airport", "airport"),
    ("Grady Memorial Hospital", "Grady Hospital", "hospital"),
    ("Piedmont Atlanta Hospital", "Piedmont Hospital", "hospital"),
    ("Emory University Hospital", "Emory University Hospital", "hospital"),
    ("Five Points", "Five Points", "transit"),
    ("Krog Street Tunnel", "Krog Street Tunnel", "attraction"),
    ("Little Five Points", "Little Five Points", "attraction"),
    ("Westside Provisions District", "Westside Provisions", "attraction"),
    ("The Battery Atlanta", "The Battery", "attraction"),
    ("Tabernacle", "The Tabernacle", "attraction"),
    ("The Tabernacle", "The Tabernacle", "attraction"),
    ("Westview Cemetery", "Westview Cemetery", "park"),
    ("Mercedes-Benz Stadium", "Mercedes-Benz Stadium", "stadium"),
    ("College Football Hall of Fame", "College Football Hall of Fame", "museum"),
    ("Underground Atlanta", "Underground Atlanta", "attraction"),
    ("Sweet Auburn Curb Market", "Sweet Auburn Market", "food"),
    ("Swan House", "Swan House", "museum"),
    ("Chastain Park Amphitheatre", "Chastain Amphitheatre", "attraction"),
    ("Truist Park", "Truist Park", "stadium"),
    ("Children's Museum of Atlanta", "Children's Museum", "museum"),
    ("Margaret Mitchell House", "Margaret Mitchell House", "museum"),
    ("Atlanta City Hall", "Atlanta City Hall", "civic"),
    ("Woodruff Arts Center", "Woodruff Arts Center", "museum"),
    ("Delta Flight Museum", "Delta Flight Museum", "museum"),
    ("Decatur Square", "Decatur Square", "attraction"),
    ("DeKalb History Center", "Old DeKalb Courthouse", "museum"),
]

SEARCH_CATS = {
    "park", "museum", "stadium_arena", "college_university", "hospital", "aquarium", "zoo",
    "historic_site", "landmark_and_historical_building", "music_venue", "theatre", "art_gallery",
    "shopping", "shopping_center", "restaurant", "bar", "coffee_shop", "hotel", "grocery_store",
    "supermarket", "gas_station", "library", "school", "elementary_school", "high_school",
    "place_of_learning", "cemetery", "golf_course", "train_station", "transit_station",
    "airport", "government_office", "fire_station", "police_station", "post_office",
    "casual_eatery", "fast_food_restaurant", "brewery", "night_club", "cinema", "movie_theater",
    "christian_place_of_worship", "sport_or_fitness_facility", "gym", "pharmacy", "bakery",
    "arts_and_entertainment", "food_and_beverage_store", "lodging", "attraction", "tourist_attraction",
    "monument", "public_plaza", "convenience_store", "department_store", "fashion_and_apparel_store",
}


def process_places(region, global_labels):
    log("processing places & landmarks")
    t, gs = load("place", ["geometry", "names", "basic_category", "confidence", "operating_status"])
    names = t.column("names").to_pylist()
    cat = t.column("basic_category").to_pylist()
    conf = t.column("confidence").to_pylist()
    status = t.column("operating_status").to_pylist()
    shapely.prepare(region)
    ins = shapely.contains(region, gs)
    by_name = collections.defaultdict(list)
    search = []
    for k in np.nonzero(ins)[0]:
        n = name_of(names[k])
        if not n:
            continue
        by_name[n.lower()].append((conf[k] or 0, gs[k], cat[k]))
        if status[k] not in (None, "open"):
            continue
        if (conf[k] or 0) >= 0.78 and cat[k] in SEARCH_CATS:
            search.append([n, cat[k] or "", round(gs[k].x, 1), round(gs[k].y, 1)])
    lm = []
    seen = set()
    for oname, label, kind in LANDMARKS:
        c = by_name.get(oname.lower())
        if not c or label in seen:
            continue
        c.sort(key=lambda x: -x[0])
        p = c[0][1]
        seen.add(label)
        lm.append(dict(n=label, k=kind, x=round(p.x, 1), y=round(p.y, 1)))
    global_labels["landmarks"] = lm
    log(f"  {len(lm)} landmarks matched, {len(search)} searchable places")
    # dedupe searchable places by (name, ~100 m)
    seen = {}
    out = []
    for n, c, x, y in search:
        key = (n.lower(), int(x // 150), int(y // 150))
        if key in seen:
            continue
        seen[key] = 1
        out.append([n, c, x, y])
    return out


# Neighbourhoods that are well known but missing from the Overture/OSM division
# layer.  Only the *label anchor* is curated (approximate centre, WGS84); no map
# geometry comes from here.
CURATED_HOODS = [
    ("Downtown", 33.7537, -84.3901, 0), ("Grant Park", 33.7383, -84.3700, 1),
    ("West Midtown", 33.7842, -84.4108, 0), ("Morningside", 33.7948, -84.3555, 1),
    ("Poncey-Highland", 33.7735, -84.3520, 1), ("Piedmont Heights", 33.8040, -84.3700, 1),
    ("Peachtree Hills", 33.8165, -84.3810, 1), ("Garden Hills", 33.8370, -84.3790, 1),
    ("East Atlanta", 33.7395, -84.3445, 1), ("Old Fourth Ward", 33.7650, -84.3705, 0),
    ("Buckhead", 33.8400, -84.3800, 0), ("Decatur", 33.7748, -84.2963, 0),
    ("Chastain Park", 33.8700, -84.3950, 1), ("Underwood Hills", 33.8060, -84.4235, 2),
    ("Loring Heights", 33.7960, -84.4045, 2), ("Berkeley Park", 33.8005, -84.4140, 2),
    ("Collier Hills", 33.8180, -84.4050, 2), ("Adair Park", 33.7265, -84.4105, 2),
    ("Oakland City", 33.7170, -84.4290, 2), ("Ormewood Park", 33.7270, -84.3510, 2),
    ("Lindbergh", 33.8235, -84.3680, 1), ("Lenox", 33.8460, -84.3620, 1),
    ("Brookhaven", 33.8650, -84.3370, 1), ("Druid Hills", 33.7800, -84.3290, 1),
    ("Kirkwood", 33.7540, -84.3230, 1), ("Edgewood", 33.7560, -84.3420, 2),
    ("Virginia-Highland", 33.7790, -84.3530, 1), ("Inman Park", 33.7590, -84.3530, 1),
    ("Little Five Points", 33.7645, -84.3490, 1), ("Atlantic Station", 33.7920, -84.3970, 1),
    ("Midtown", 33.7840, -84.3830, 0), ("Home Park", 33.7870, -84.4040, 2),
    ("Cabbagetown", 33.7505, -84.3640, 2), ("Reynoldstown", 33.7480, -84.3530, 2),
    ("Summerhill", 33.7400, -84.3830, 2), ("West End", 33.7360, -84.4130, 1),
    ("Castleberry Hill", 33.7480, -84.4010, 2), ("Vine City", 33.7560, -84.4110, 2),
    ("English Avenue", 33.7700, -84.4160, 2), ("Ansley Park", 33.7940, -84.3790, 1),
    ("Candler Park", 33.7640, -84.3390, 2), ("Lake Claire", 33.7690, -84.3270, 2),
    ("East Lake", 33.7460, -84.3010, 2), ("Sweet Auburn", 33.7550, -84.3780, 2),
    ("Westview", 33.7430, -84.4280, 2), ("Mechanicsville", 33.7330, -84.3960, 2),
    ("Peoplestown", 33.7310, -84.3830, 2), ("Pittsburgh", 33.7240, -84.4000, 2),
]


def process_neighborhoods(region, global_labels):
    log("processing neighborhoods")
    t, gs = load("division", ["geometry", "names", "subtype", "class"])
    names = t.column("names").to_pylist()
    sub = t.column("subtype").to_pylist()
    cls = t.column("class").to_pylist()
    out = []
    shapely.prepare(region)
    for g, n, s, c in zip(gs, names, sub, cls):
        n = name_of(n)
        if not n or g.geom_type != "Point" or not region.contains(g):
            continue
        rank = {"macrohood": 0, "neighborhood": 1, "microhood": 2, "locality": 0}.get(s)
        if rank is None:
            continue
        if s == "locality" and n == "Atlanta":
            continue
        out.append(dict(n=n, r=rank, x=round(g.x, 1), y=round(g.y, 1), s=s, src="osm"))
    have = {o["n"].lower().replace("-", " ") for o in out}
    alias = {"virginia highland": "virginia-highland", "english ave.": "english avenue", "ormewood": "ormewood park"}
    have |= {alias.get(h, h) for h in have}
    for n, lat, lon, r in CURATED_HOODS:
        key = n.lower().replace("-", " ")
        x, y = TF.transform(lon, lat)
        y = -y
        exists = [o for o in out if o["n"].lower().replace("-", " ") == key or alias.get(o["n"].lower(), "") == n.lower()]
        if exists:
            for o in exists:  # promote rank of well-known names
                o["r"] = min(o["r"], r)
            continue
        out.append(dict(n=n, r=r, x=round(x, 1), y=round(y, 1), s="curated", src="curated"))
    # areas (polygons) for "you are in" lookups
    t2, g2 = load("division_area", ["geometry", "names", "subtype"])
    areas = []
    for g, n, s in zip(g2, t2.column("names").to_pylist(), t2.column("subtype").to_pylist()):
        n = name_of(n)
        if not n or s not in ("neighborhood", "microhood", "locality", "macrohood"):
            continue
        if not shapely.intersects(region, g):
            continue
        gg = g.intersection(region).simplify(15)
        polys = []
        for p in getattr(gg, "geoms", [gg]):
            if p.geom_type == "Polygon":
                polys.append(np.round(shapely.get_coordinates(p.exterior), 0).reshape(-1).tolist())
        if polys:
            areas.append(dict(n=n, s=s, rings=polys))
    global_labels["hoods"] = out
    global_labels["hoodAreas"] = areas
    log(f"  {len(out)} neighborhood labels ({sum(1 for o in out if o['src']=='curated')} curated anchors), {len(areas)} areas")
    return out


# ------------------------------------------------------------ spawn --------

def find_spawn(seg_t, seg_g):
    """Spawn on Peachtree St NE ~70 m south of 10th St NE, facing north."""
    names = [name_of(n) for n in seg_t.column("names").to_pylist()]
    cls = seg_t.column("class").to_pylist()
    pt = [g for g, n, c in zip(seg_g, names, cls) if n == "Peachtree Street Northeast" and c != "footway"]
    tn = [g for g, n, c in zip(seg_g, names, cls) if n == "10th Street Northeast" and c != "footway"]
    pl = shapely.line_merge(shapely.union_all(pt))
    tl = shapely.union_all(tn)
    near = shapely.ops.nearest_points(pl, tl)[0]
    best = None
    for ln in getattr(pl, "geoms", [pl]):
        if ln.distance(near) < 1:
            d = ln.project(near)
            for dd in (d - 70, d + 70):
                if 0 <= dd <= ln.length:
                    p = ln.interpolate(dd)
                    if best is None or p.y > best[0].y:
                        best = (p, ln.interpolate(dd + (5 if dd < d else -5)))
    p, q = best
    heading = math.atan2(q.y - p.y, q.x - p.x)
    log(f"  spawn at {p.x:.1f},{p.y:.1f} heading {math.degrees(heading):.0f} deg")
    return dict(x=round(p.x, 1), y=round(p.y, 1), heading=round(heading, 4))


# ------------------------------------------------------------ main ---------

def main():
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    seg_t, seg_g = load("segment", ["id", "names", "subtype", "class", "subclass", "road_flags", "rail_flags",
                                    "level_rules", "access_restrictions", "routes", "connectors", "geometry"])
    perim = build_perimeter(seg_t, seg_g)
    region = perim.buffer(350, join_style="round")
    shapely.prepare(region)
    store = Store()
    global_labels = {}

    label_pieces, shield_pieces, routing, drivable = process_roads(store, seg_t, seg_g, region, None)
    build_routing(routing)
    chunks_with_labels, gl_streets, search_streets = label_candidates(label_pieces)
    global_labels["streets"] = gl_streets
    global_labels["shields"] = shield_candidates(shield_pieces)
    process_areas(store, region, global_labels)
    process_buildings(store, region, drivable)
    places = process_places(region, global_labels)
    hoods = process_neighborhoods(region, global_labels)
    log("writing chunks")
    index = store.write()

    with open(os.path.join(OUT, "labels", "global.json"), "w") as f:
        json.dump(global_labels, f, separators=(",", ":"))

    search = dict(
        streets=sorted({(n, r, q[0], q[1]) for n, r, q in search_streets}),
        places=places,
        hoods=[[h["n"], h["x"], h["y"]] for h in hoods],
        landmarks=[[l["n"], l["k"], l["x"], l["y"]] for l in global_labels["landmarks"]],
    )
    with open(os.path.join(OUT, "search.json"), "w") as f:
        json.dump(search, f, separators=(",", ":"))

    spawn = find_spawn(seg_t, seg_g)
    pr = np.round(shapely.get_coordinates(perim.exterior), 1).reshape(-1).tolist()
    xb = region.bounds
    manifest = dict(
        version=1,
        generated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        source="OpenStreetMap contributors via Overture Maps Foundation release 2026-09-23.1 (ODbL / CDLA)",
        projection=dict(proj="tmerc", lat0=LAT0, lon0=LON0, k=1, ellps="WGS84", yFlip=True),
        lods={str(k): dict(size=v["size"], unit=v["unit"], chunks=index[k]) for k, v in LODS.items()},
        labelChunks=sorted([list(k) for k in chunks_with_labels]),
        labelChunkSize=LODS[1]["size"],
        perimeter=pr,
        region=np.round(shapely.get_coordinates(region.simplify(4).exterior), 1).reshape(-1).tolist(),
        regionBuffer=350,
        bounds=[round(b, 1) for b in xb],
        spawn=spawn,
    )
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, separators=(",", ":"))
    log(f"done in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
