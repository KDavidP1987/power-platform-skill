#!/usr/bin/env python3
"""check-published-order.py - compare control (z-)order in the published app with the repo.

Declaration order in .pa.yaml is z-order: a later sibling draws over an earlier one. A co-authoring
push does not reorder controls Studio already has, so a push that inserts or moves controls can
publish a card on top of its gallery while every property matches. A property compare cannot see
this; this check can (canvas-shipping.md section 4, audits.md).

Usage:
  pac canvas download --name <appId> --environment <envId> --extract-to-directory <dir>
  python scripts/check-published-order.py <dir>/Src [<repo Src dir>]
  python scripts/check-published-order.py --selftest

The repo Src defaults to canvasSrc in scripts/canvas-app.json.
Exit codes: 0 order matches, 1 a container is out of order, 2 nothing compared.
"""
import json
import os
import re
import sys
import tempfile

ITEM = re.compile(r'^(\s*)- ([A-Za-z_][A-Za-z0-9_]*):\s*$')


def siblings(path):
    """{parent: [child names in declaration order]} for every container in a screen file."""
    out, stack = {}, []
    with open(path, encoding='utf-8') as f:
        for line in f:
            m = ITEM.match(line)
            if not m:
                continue
            ind, name = len(m.group(1)), m.group(2)
            while stack and stack[-1][0] >= ind:
                stack.pop()
            out.setdefault(stack[-1][1] if stack else '(screen)', []).append(name)
            stack.append((ind, name))
    return out


def compare(pub, repo, out=print):
    bad = compared = 0
    for f in sorted(os.listdir(repo)):
        if not f.endswith('.pa.yaml') or f == 'App.pa.yaml' or not os.path.exists(os.path.join(pub, f)):
            continue
        compared += 1
        r, p = siblings(os.path.join(repo, f)), siblings(os.path.join(pub, f))
        for parent, kids in r.items():
            pk = p.get(parent, [])
            common = [k for k in kids if k in pk]
            pub_order = [k for k in pk if k in common]
            if common != pub_order:
                bad += 1
                pos = {k: i for i, k in enumerate(pub_order)}
                a, b = next((a, b) for i, a in enumerate(common) for b in common[i + 1:] if pos[a] > pos[b])
                out(f'ORDER  {f}  {parent}: repo has {a} before {b}, published has it after (so {a} draws on top)')
    return bad, compared


def selftest():
    def screen(order):
        return 'Screens:\n  Home:\n    Children:\n' + ''.join(
            f'      - {n}:\n          Control: Label@2.5.1\n' for n in order)
    ok = True
    for name, repo, pub, want in [('same order', ['lblA', 'galB', 'cardC'], ['lblA', 'galB', 'cardC'], 0),
                                  ('card moved under gallery', ['lblA', 'galB', 'cardC'], ['lblA', 'cardC', 'galB'], 1)]:
        with tempfile.TemporaryDirectory() as t:
            for side, order in (('repo', repo), ('pub', pub)):
                os.makedirs(os.path.join(t, side))
                with open(os.path.join(t, side, 'Home.pa.yaml'), 'w', encoding='utf-8', newline='\n') as f:
                    f.write(screen(order))
            bad, n = compare(os.path.join(t, 'pub'), os.path.join(t, 'repo'), out=lambda s: None)
            good = (bad == want and n == 1)
            ok &= good
            print(('ok    ' if good else 'FAIL  ') + name)
    print('selftest ' + ('passed' if ok else 'FAILED'))
    return 0 if ok else 1


def main():
    a = sys.argv[1:]
    if not a or a[0] in ('-h', '--help'):
        print(__doc__)
        return 2
    if a[0] == '--selftest':
        return selftest()
    repo = a[1] if len(a) > 1 else None
    if not repo:
        try:
            with open(os.path.join('scripts', 'canvas-app.json'), encoding='utf-8') as f:
                repo = json.load(f)['canvasSrc']
        except Exception:
            print('give the repo Src dir, or run from the repo root with scripts/canvas-app.json')
            return 2
    bad, n = compare(a[0], repo)
    if n == 0:
        print('nothing compared: no screen file exists in both folders (wrong path?)')
        return 2
    print(f'{bad} container(s) out of order across {n} screen(s)' if bad else f'order ok: {n} screen(s) match the repo')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
