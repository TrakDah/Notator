#!/usr/bin/env python3
"""Rebuild index.html from src/. Run from the repository root: python3 src/build.py"""
import html
from pathlib import Path

root = Path(__file__).resolve().parent.parent
tpl = (root / 'src' / 'ui.template.html').read_text()
lib = (root / 'src' / 'sonlib.js').read_text()
gpl = (root / 'LICENSE').read_text()
out = tpl.replace('/*__SONLIB__*/', lib).replace('__GPLTEXT__', html.escape(gpl))
(root / 'index.html').write_text(out)
print(f'Wrote index.html ({len(out)} bytes)')
