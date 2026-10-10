import os


class ReportNotFound(Exception):
    pass


class ReportStore:
    """Generated report files kept under one root directory."""

    def __init__(self, root):
        self.root = root

    def names(self):
        """Relative paths (with / separators) of all reports, sorted."""
        found = []
        for dirpath, _dirs, files in os.walk(self.root):
            for f in files:
                rel = os.path.relpath(os.path.join(dirpath, f), self.root)
                found.append(rel.replace(os.sep, "/"))
        return sorted(found)
