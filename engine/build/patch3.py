import os
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/wasm/hce")
PATHS = {
    "h": os.path.join(ROOT, "src", "thread.h"),
    "c": os.path.join(ROOT, "src", "thread.cpp"),
}

EDITS = [
    ("c", """Thread::Thread(size_t n) : idx(n), stdThread(&Thread::idle_loop, this) {

  wait_for_search_finished();
}""", """#ifdef __EMSCRIPTEN__
Thread::Thread(size_t n) : idx(n) {}
#else
Thread::Thread(size_t n) : idx(n), stdThread(&Thread::idle_loop, this) {

  wait_for_search_finished();
}
#endif"""),

    ("c", """  exit = true;
  start_searching();
  stdThread.join();
}""", """#ifdef __EMSCRIPTEN__
  // No native thread to wake up or join.
#else
  exit = true;
  start_searching();
  stdThread.join();
#endif
}"""),

    ("c", """  std::lock_guard<std::mutex> lk(mutex);
  searching = true;
  cv.notify_one(); // Wake up the thread in idle_loop()
}""", """#ifdef __EMSCRIPTEN__
  searching = true;
  search();
  searching = false;
#else
  std::lock_guard<std::mutex> lk(mutex);
  searching = true;
  cv.notify_one(); // Wake up the thread in idle_loop()
#endif
}"""),

    ("c", """  std::unique_lock<std::mutex> lk(mutex);
  cv.wait(lk, [&]{ return !searching; });
}""", """#ifdef __EMSCRIPTEN__
  // The search ran inline in start_searching(), so it is already finished.
#else
  std::unique_lock<std::mutex> lk(mutex);
  cv.wait(lk, [&]{ return !searching; });
#endif
}"""),

    ("h", """  bool exit = false, searching = true; // Set before starting std::thread
  NativeThread stdThread;""", """  bool exit = false, searching = true; // Set before starting std::thread
#ifdef __EMSCRIPTEN__
#else
  NativeThread stdThread;
#endif"""),
]

text = {k: open(v).read() for k, v in PATHS.items()}
applied = 0

for i, (tgt, old, new) in enumerate(EDITS):
    t = text[tgt]
    if new in t:
        print("edit %d: already applied" % i)
        continue
    if t.count(old) != 1:
        print("edit %d (%s): found %d matches, expected 1" % (i, tgt, t.count(old)))
        sys.exit(1)
    text[tgt] = t.replace(old, new, 1)
    applied += 1
    print("edit %d: applied" % i)

for k, v in PATHS.items():
    open(v, "w").write(text[k])
print("done, %d edits applied" % applied)
