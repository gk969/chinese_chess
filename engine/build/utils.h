#ifndef EMSCRIPTEN_UTILS_H_INCLUDED
#define EMSCRIPTEN_UTILS_H_INCLUDED

#include <cstdlib>
#include <emscripten.h>
#include <string>

EM_JS(const char*, emscripten_utils_getline_impl, (), {
  const toHeap = (js_str) => {
    const num_bytes = lengthBytesUTF8(js_str) + 1;
    const ptr = _malloc(num_bytes);
    stringToUTF8(js_str, ptr, num_bytes);
    return ptr;
  };

  return Asyncify.handleAsync(async () => {
    return toHeap(await Module["queue"].get());
  });
});

void emscripten_utils_getline(std::string& result) {
  const char* ptr = emscripten_utils_getline_impl();
  result = ptr;
  std::free((void*)ptr);
}

#endif
