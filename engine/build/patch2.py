import os
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/wasm/hce")
p = os.path.join(ROOT, "src", "misc.cpp")
lines = open(p).read().split("\n")

if any("__EMSCRIPTEN__" in l and "GETCWD" not in l for l in lines):
    i = next(i for i, l in enumerate(lines) if l.strip() == "char buff[40000];")
    if lines[i - 1].strip() == "#ifndef __EMSCRIPTEN__":
        print("misc.cpp already patched")
        sys.exit(0)

out = []
done = False
for l in lines:
    if not done and l.strip() == "char buff[40000];":
        out.append("#ifndef __EMSCRIPTEN__")
        out.append(l)
        done = True
        continue
    if done and l.strip() == "workingDirectory = cwd;":
        out.append(l)
        out.append("#endif")
        done = "closed"
        continue
    out.append(l)

assert done == "closed", "getcwd anchor not found"
open(p, "w").write("\n".join(out))
print("misc.cpp patched")
