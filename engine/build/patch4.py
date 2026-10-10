import os
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/wasm/hce")
P = os.path.join(ROOT, "src", "tt.cpp")
t = open(P).read()

OLD = """void TranspositionTable::clear() {

  std::vector<std::thread> threads;"""

NEW = """void TranspositionTable::clear() {

#ifdef __EMSCRIPTEN__
  std::memset(table, 0, clusterCount * sizeof(Cluster));
#else
  std::vector<std::thread> threads;"""

OLD2 = """  for (std::thread& th : threads)
      th.join();
}"""

NEW2 = """  for (std::thread& th : threads)
      th.join();
#endif
}"""

if NEW in t and NEW2 in t:
    print("tt.cpp already patched")
    sys.exit(0)

for name, s, want in (("OLD", OLD, 1), ("OLD2", OLD2, 1)):
    if t.count(s) != want:
        print("%s: found %d matches, expected %d" % (name, t.count(s), want))
        sys.exit(1)

t = t.replace(OLD, NEW, 1).replace(OLD2, NEW2, 1)
open(P, "w").write(t)
print("tt.cpp patched")
