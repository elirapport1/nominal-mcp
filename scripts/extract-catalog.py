import inspect, importlib, pkgutil, os, re, json, typing
import nominal_api

p = os.path.dirname(nominal_api.__file__)
mods = sorted(m.name for m in pkgutil.iter_modules([p]))

VERB = re.compile(r"self\._request\(\s*'([A-Z]+)'")
PATH = re.compile(r"_path\s*=\s*'([^']+)'")
PATHP = re.compile(r"_path_params:\s*Dict\[str,\s*str\]\s*=\s*\{(.*?)\n\s*\}", re.S)
PARAMS = re.compile(r"_params:\s*Dict\[str,\s*Any\]\s*=\s*\{(.*?)\n\s*\}", re.S)
KV = re.compile(r"'([^']+)'\s*:\s*([^,\n]+)")
JSONB = re.compile(r"_json:\s*Any\s*=\s*(.+)")
RETTYPE = re.compile(r"decode\(_response\.json\(\),\s*(.+?),\s*self\._return_none", re.S)
STREAM = re.compile(r"stream=True")

out = []
for mn in mods:
    try: mod = importlib.import_module(f"nominal_api.{mn}")
    except Exception: continue
    for cname, cls in vars(mod).items():
        if not inspect.isclass(cls) or not cname.endswith("Service"): continue
        if cls.__module__ != mod.__name__: continue
        for fname, fn in inspect.getmembers(cls, inspect.isfunction):
            if fname.startswith("_"): continue
            try: src = inspect.getsource(fn)
            except Exception: continue
            v = VERB.search(src); pa = PATH.search(src)
            if not v or not pa: continue
            sig = inspect.signature(fn)
            args = [a for a in sig.parameters if a not in ("self","auth_header")]
            pp = PATHP.search(src); qp = PARAMS.search(src)
            pathp = dict(KV.findall(pp.group(1))) if pp else {}
            queryp = dict(KV.findall(qp.group(1))) if qp else {}
            jb = JSONB.search(src)
            rt = RETTYPE.search(src)
            ann = {a: str(sig.parameters[a].annotation).replace("ForwardRef","").replace("'","") for a in args}
            out.append({
                "service": f"{mn}.{cname}",
                "op": fname,
                "method": v.group(1),
                "path": pa.group(1),
                "path_params": {k: val.strip() for k, val in pathp.items()},
                "query_params": {k: val.strip() for k, val in queryp.items()},
                "body_arg": jb.group(1).strip() if jb else None,
                "args": args,
                "arg_types": ann,
                "returns": " ".join(rt.group(1).split()) if rt else ("binary/stream" if STREAM.search(src) else "None"),
                "binary": bool(STREAM.search(src)),
            })

out.sort(key=lambda e: (e["service"], e["op"]))
json.dump(out, open("catalog.json","w"), indent=1)
print("endpoints extracted:", len(out))
print("verbs:", {v: sum(1 for e in out if e['method']==v) for v in sorted({e['method'] for e in out})})
print("path prefixes:", sorted({ '/'.join(e['path'].split('/')[:3]) for e in out })[:40])
