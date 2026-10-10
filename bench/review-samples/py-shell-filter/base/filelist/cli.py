import argparse
import os
import sys


def list_files(root):
    """Relative paths of all files under root, sorted."""
    names = []
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            names.append(os.path.relpath(os.path.join(dirpath, f), root))
    return sorted(names)


def build_parser():
    p = argparse.ArgumentParser(prog="filelist")
    sub = p.add_subparsers(dest="command", required=True)
    ls = sub.add_parser("list", help="list files under a directory")
    ls.add_argument("root", nargs="?", default=".")
    return p


def main(argv=None, out=None):
    out = out or sys.stdout
    args = build_parser().parse_args(argv)
    if args.command == "list":
        for name in list_files(args.root):
            out.write(name + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
