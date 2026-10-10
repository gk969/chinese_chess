import os
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/wasm/hce")
p = os.path.join(ROOT, "src", "uci.cpp")
lines = open(p).read().split("\n")

if any("__EMSCRIPTEN__" in l for l in lines):
    print("uci.cpp already patched")
    sys.exit(0)

out = []
done_inc = False
done_loop = False
for i, l in enumerate(lines):
    if not done_inc and l.strip() == '#include "uci.h"':
        out.append(l)
        out.append("#ifdef __EMSCRIPTEN__")
        out.append('#include "emscripten/utils.h"')
        out.append("#endif")
        done_inc = True
        continue
    if not done_loop and "!getline(cin, cmd)" in l:
        ind = l[: len(l) - len(l.lstrip())]
        out.append("#ifdef __EMSCRIPTEN__")
        out.append(ind + "if (argc == 1)")
        out.append(ind + "    emscripten_utils_getline(cmd);")
        out.append(ind + "else")
        out.append("#endif")
        out.append(l.replace("!getline(cin, cmd)", "!getline(cin, cmd)"))
        done_loop = True
        continue
    out.append(l)

assert done_inc, "include anchor not found"
assert done_loop, "getline anchor not found"
open(p, "w").write("\n".join(out))
print("uci.cpp patched")
