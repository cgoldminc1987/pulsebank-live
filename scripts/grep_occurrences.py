import os
import re

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
s = open(os.path.join(root, "index.html"), encoding="utf-8").read()
for m in re.finditer(r"api\.pulsebank\.ca", s):
    a, b = max(0, m.start() - 100), min(len(s), m.end() + 100)
    print(f"--- offset {m.start()} ---")
    print(s[a:b].replace("\n", "\\n"))
