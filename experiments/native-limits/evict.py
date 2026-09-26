"""Verify disk-state cache eviction before a fresh measured cgroup reads it."""
import ctypes
import json
import mmap
import os
import sys

libc = ctypes.CDLL(None, use_errno=True)
libc.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
libc.mincore.restype = ctypes.c_int
page_bytes = os.sysconf("SC_PAGESIZE")


def resident_pages(source, size):
    if size == 0:
        return 0
    # ACCESS_COPY supplies an address without reading or faulting any file page.
    with mmap.mmap(source.fileno(), size, access=mmap.ACCESS_COPY) as mapping:
        address = ctypes.addressof(ctypes.c_char.from_buffer(mapping))
        pages = (size + page_bytes - 1) // page_bytes
        vector = (ctypes.c_ubyte * pages)()
        if libc.mincore(address, size, vector) != 0:
            raise OSError(ctypes.get_errno(), "mincore")
        return sum(value & 1 for value in vector)


os.sync()
records = []
for root, _, names in os.walk(sys.argv[1]):
    for name in names:
        pathname = os.path.join(root, name)
        if os.path.islink(pathname) or not os.path.isfile(pathname):
            continue
        with open(pathname, "rb") as source:
            size = os.fstat(source.fileno()).st_size
            before = resident_pages(source, size)
            os.posix_fadvise(source.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
            after = resident_pages(source, size)
            records.append({"file": os.path.relpath(pathname, sys.argv[1]),
                            "bytes": size, "residentPagesBefore": before,
                            "residentPagesAfter": after})
            if after:
                raise RuntimeError(f"Cache eviction incomplete: {pathname}: {after} pages")
print(json.dumps({"files": len(records), "bytes": sum(r["bytes"] for r in records),
                  "method": "sync + POSIX_FADV_DONTNEED + mincore verification",
                  "pageBytes": page_bytes, "records": records}))
