#!/usr/bin/env python3
"""Keep both sides of every conflict hunk in the named files (additive collisions only)."""
import re
import sys

for path in sys.argv[1:]:
    src = open(path).read()
    out = []
    mode = None
    ours, theirs = [], []
    for line in src.split('\n'):
        if line.startswith('<<<<<<<'):
            mode, ours, theirs = 'ours', [], []
        elif line.startswith('|||||||') and mode:
            mode = 'base'
        elif line.startswith('=======') and mode:
            mode = 'theirs'
        elif line.startswith('>>>>>>>') and mode:
            out.extend(ours)
            out.extend(theirs)
            mode = None
        elif mode == 'ours':
            ours.append(line)
        elif mode == 'theirs':
            theirs.append(line)
        elif mode == 'base':
            pass
        else:
            out.append(line)
    open(path, 'w').write('\n'.join(out))
    print('unioned', path)
