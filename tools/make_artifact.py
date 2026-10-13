#!/usr/bin/env python3
"""
Package dist/ (output of `npm run build`) as a single hostable page for hosts
that only serve standard web file types (e.g. a claude.ai Artifact):

  * the page markup is written without its <html>/<head>/<body> wrapper
  * binary world files (.pack, .bin) are renamed with a .wasm suffix (served as
    raw bytes) and manifest.json gets "binSuffix": ".wasm" so the game asks for them

Output: dist-artifact/  (+ dist-artifact/files.json listing published files)
"""
import json, os, re, shutil

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "dist")
OUT = os.path.join(ROOT, "dist-artifact")
SUFFIX = ".wasm"

shutil.rmtree(OUT, ignore_errors=True)
files = {}
for root, _, names in os.walk(SRC):
    for n in names:
        rel = os.path.relpath(os.path.join(root, n), SRC)
        if rel == "index.html":
            continue
        dst = rel + SUFFIX if rel.endswith((".pack", ".bin")) else rel
        os.makedirs(os.path.dirname(os.path.join(OUT, dst)), exist_ok=True)
        shutil.copyfile(os.path.join(SRC, rel), os.path.join(OUT, dst))
        files[dst] = dst

mpath = os.path.join(OUT, "world", "manifest.json")
m = json.load(open(mpath))
m["binSuffix"] = SUFFIX
json.dump(m, open(mpath, "w"), separators=(",", ":"))

html = open(os.path.join(SRC, "index.html")).read()
head = html[html.index("<head>") + 6: html.index("</head>")]
body = html[html.index("<body>") + 6: html.index("</body>")]
title = re.search(r"<title>.*?</title>", head).group(0)
icon = re.search(r'<link rel="icon"[^>]*>', head).group(0)
css = re.search(r'<link rel="stylesheet"[^>]*>', head).group(0).replace(" crossorigin", "")
js = re.search(r'<script type="module"[^>]*></script>', head).group(0).replace(" crossorigin", "")
open(os.path.join(OUT, "play.html"), "w").write(f"{title}\n{icon}\n{css}\n{body.strip()}\n{js}\n")
json.dump(files, open(os.path.join(OUT, "files.json"), "w"), indent=0)
size = sum(os.path.getsize(os.path.join(OUT, f)) for f in files)
print(f"{len(files)} files, {size / 1e6:.1f} MB -> {OUT}/play.html")
