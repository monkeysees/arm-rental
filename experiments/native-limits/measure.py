"""Measure the external coordinator and its waited-for helper process tree."""
import json
import resource
import subprocess
import sys
import time
from pathlib import Path

record = Path(sys.argv[1])
if record.exists():
    raise FileExistsError(record)
started = time.monotonic()
process = subprocess.run(sys.argv[2:], check=False)
usage = resource.getrusage(resource.RUSAGE_CHILDREN)
record.write_text(json.dumps({
    "command": sys.argv[2:],
    "exitCode": process.returncode,
    "wallSeconds": time.monotonic() - started,
    "userCpuSeconds": usage.ru_utime,
    "systemCpuSeconds": usage.ru_stime,
    "largestProcessPeakRssBytes": usage.ru_maxrss * 1024,
    "majorFaults": usage.ru_majflt,
    "minorFaults": usage.ru_minflt,
    "inputBlocks": usage.ru_inblock,
    "outputBlocks": usage.ru_oublock,
    "boundary": "External Node coordinator plus waited-for CLI, eviction, and archive helper descendants. Linux maxRSS is the largest individual process high-water mark, not their simultaneous sum. Separate fixture-container costs are in manifest.json; Docker daemon and host OS excluded."
}, indent=2) + "\n")
sys.exit(process.returncode)
