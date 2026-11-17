"""Run argv under a pseudo terminal, feed it the lines on stdin, print what it wrote and exit with its status.

Used by resume-hook-shells.test.mjs: the resume block checks `[ -t 0 ]` and runs from an interactive shell's prompt, which needs a terminal.
usage: pty_run.py <input text> <argv...>
"""
import os
import pty
import select
import sys
import time

text, argv = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
os.write(fd, text.encode())
out = b""
end = time.time() + 20
while time.time() < end:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    else:
        done, _ = os.waitpid(pid, os.WNOHANG)
        if done:
            break
try:
    _, status = os.waitpid(pid, 0)
except ChildProcessError:
    status = 0
sys.stdout.write(out.decode("utf8", "replace"))
sys.exit(os.waitstatus_to_exitcode(status))
