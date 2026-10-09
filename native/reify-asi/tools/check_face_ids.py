#!/usr/bin/env python3
"""E0-b: face IDs of reify-asi match FreeCAD's Shape.Faces[n-1].

For every part written by make_test_parts.py this script runs

    reify-asi analyze --in part.brep --dump-faces

and compares, face by face, the centroid and area with the values FreeCAD
recorded for the same shape (Shape.Faces[n-1].CenterOfMass and .Area, saved
in part.freecad.json). The BRep file is read back by OCCT 7.6 in reify-asi,
so a pass also shows that FreeCAD-written .brep files load in OCCT 7.6.

Pass criteria (per part): same face count; for every face the centroid
distance is <= 1e-6 * bounding-box diagonal and the area differs by at most
1e-6 relative (absolute 1e-9 for tiny faces). No fallback matching is done:
a mismatch is a failure.

Usage (any Python 3; no FreeCAD import needed):

    python3 native/reify-asi/tools/check_face_ids.py \
        --reify-asi <bin>/reify-asi --parts <dir written by make_test_parts.py>

Exit 0 when all parts pass, 1 when any part fails, 2 on usage error.
"""
import argparse
import json
import math
import os
import subprocess
import sys


def run_dump(binary, brep):
    proc = subprocess.run([binary, "analyze", "--in", brep, "--dump-faces"],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RuntimeError("reify-asi exit %d: %s" % (proc.returncode, proc.stderr.strip()))
    return json.loads(proc.stdout)["faces"]


def close(a, b, rel, abs_tol):
    return abs(a - b) <= max(abs_tol, rel * max(abs(a), abs(b)))


def compare(ref_faces, got_faces, diag, rel_tol):
    if len(ref_faces) != len(got_faces):
        return ["face count differs: FreeCAD %d, reify-asi %d" % (len(ref_faces), len(got_faces))]
    problems = []
    pos_tol = rel_tol * diag
    for ref, got in zip(ref_faces, got_faces):
        dc = math.dist(ref["centroid"], got["centroid"])
        if dc > pos_tol:
            problems.append("face %d centroid off by %.3g (tol %.3g)" % (ref["id"], dc, pos_tol))
        if not close(ref["area"], got["area"], rel_tol, 1e-9):
            problems.append("face %d area %.12g vs %.12g" % (ref["id"], ref["area"], got["area"]))
    return problems


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--reify-asi", required=True, help="path to the reify-asi binary")
    ap.add_argument("--parts", required=True, help="directory with *.brep and *.freecad.json")
    ap.add_argument("--rel-tol", type=float, default=1e-6)
    args = ap.parse_args(argv)

    if not os.access(args.reify_asi, os.X_OK):
        print("reify-asi not executable: %s" % args.reify_asi, file=sys.stderr)
        return 2
    refs = sorted(f for f in os.listdir(args.parts) if f.endswith(".freecad.json"))
    if not refs:
        print("no *.freecad.json in %s" % args.parts, file=sys.stderr)
        return 2

    failed = 0
    for name in refs:
        with open(os.path.join(args.parts, name)) as fh:
            ref = json.load(fh)
        brep = os.path.join(args.parts, ref["name"] + ".brep")
        try:
            got = run_dump(args.reify_asi, brep)
        except RuntimeError as exc:
            print("FAIL %-20s %s" % (ref["name"], exc))
            failed += 1
            continue
        problems = compare(ref["faces"], got, ref["bbox_diag"], args.rel_tol)
        if problems:
            failed += 1
            print("FAIL %-20s faces=%d" % (ref["name"], len(ref["faces"])))
            for p in problems[:5]:
                print("     " + p)
        else:
            print("PASS %-20s faces=%d" % (ref["name"], len(ref["faces"])))
    print("%d/%d parts match" % (len(refs) - failed, len(refs)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
