#!/usr/bin/env python3
"""
Download the Atlanta ITP subset of the Overture Maps release from the public
AWS S3 bucket (no API key needed).

Overture's transportation / base / divisions themes are derived from
OpenStreetMap (every segment keeps its OSM way id in `sources`), so this is
the same real OSM street geometry, just distributed as GeoParquet.  It is used
because it can be range-read with a bbox filter, which keeps the download small.

Usage:  python3 tools/fetch_overture.py [--release 2026-09-23.1] [--only segment,building]
Output: data/raw/<type>.parquet   (cached; delete a file to re-download it)
"""
import argparse, os, sys, time
import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.fs as pafs
import pyarrow.parquet as pq

# Generous bbox around the I-285 perimeter (the build step clips to the actual
# interstate geometry later).
BBOX = dict(xmin=-84.565, xmax=-84.205, ymin=33.615, ymax=33.935)

TYPES = {
    "segment":        ("transportation", "segment"),
    "connector":      ("transportation", "connector"),
    "building":       ("buildings", "building"),
    "land_use":       ("base", "land_use"),
    "land_cover":     ("base", "land_cover"),
    "water":          ("base", "water"),
    "infrastructure": ("base", "infrastructure"),
    "division":       ("divisions", "division"),
    "division_area":  ("divisions", "division_area"),
    "place":          ("places", "place"),
}

# Columns we drop to keep the cache small (heavy nested metadata we never use).
DROP = {"names": None}  # placeholder; we keep names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--release", default="2026-09-23.1")
    ap.add_argument("--only", default="")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "raw"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    kw = dict(anonymous=True, region="us-west-2")
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if proxy:
        kw["proxy_options"] = proxy
    s3 = pafs.S3FileSystem(**kw)

    only = [t for t in a.only.split(",") if t] or list(TYPES)
    for t in only:
        theme, typ = TYPES[t]
        dst = os.path.join(a.out, f"{t}.parquet")
        if os.path.exists(dst):
            print(f"[skip] {t} (cached)")
            continue
        src = f"overturemaps-us-west-2/release/{a.release}/theme={theme}/type={typ}/"
        t0 = time.time()
        d = ds.dataset(src, filesystem=s3, format="parquet")
        b = ds.field("bbox")
        flt = ((ds.field("bbox", "xmin") <= BBOX["xmax"]) & (ds.field("bbox", "xmax") >= BBOX["xmin"]) &
               (ds.field("bbox", "ymin") <= BBOX["ymax"]) & (ds.field("bbox", "ymax") >= BBOX["ymin"]))
        tbl = d.to_table(filter=flt)
        pq.write_table(tbl, dst + ".tmp", compression="zstd")
        os.replace(dst + ".tmp", dst)
        print(f"[ok] {t}: {tbl.num_rows} rows in {time.time()-t0:.0f}s -> {dst}", flush=True)


if __name__ == "__main__":
    main()
