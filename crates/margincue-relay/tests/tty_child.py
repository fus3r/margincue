"""Small byte-level fixture for the nested-PTY tests. Does not use an agent."""

import fcntl
import os
from pathlib import Path
import signal
import struct
import sys
import termios
import tty


def out(data):
    os.write(1, data)


def read_through(suffix):
    result = bytearray()
    while not result.endswith(suffix):
        result += os.read(0, 1)
    return bytes(result)


def size():
    return struct.unpack("HHHH", fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))


def report_size():
    out(("\x1b[1;1H" + f"SIZE {size()}").encode())


mode = sys.argv[1]
if mode == "editor-read":
    Path(sys.argv[2]).write_bytes(Path(sys.argv[3]).read_bytes())
    sys.exit(0)

tty.setraw(0)
if mode == "relay":
    signal.signal(signal.SIGWINCH, lambda *_: report_size())
out(b"\x1b[1;1HREADY")
while key := os.read(0, 1):
    if mode == "bench":
        if key == b"e":
            break
        if key in (b"x", b"\x1b"):
            out(b"\x1b[2;1H!" + b"A" * 47)
        elif key == b"y":
            out(b"\x1b[2;1H" + b"\x1b[37m" + b"A" * 4040 + b"\x1b[m!")
        continue
    if key == b"j":
        out(b"\x1b[4;9Hbefore\x1b[4;9H\x1b[Jafter")
    elif key == b"n":
        out(b"\x1b[2J\x1b[1;1HCLEARED")
    elif key == b"o":
        out(b"\x1b[2;5r\x1b[?6h\x1b[2;5Hbefore\x1b[2;5H\x1b[Jafter"
            b"\x1b[?6l\x1b[r\x1b[2;1HORIGIN")
    elif key == b"a":
        out(b"\x1b[?2026h\x1b[?1049h\x1b[2J\x1b[1;1HIN ALT\x1b[?2026l")
    elif key == b"b":
        out(b"\x1b[?1049l\x1b[7;7HBACK")
    elif key == b"r":
        out(b"\x1bc\x1b[1;1HRESET")
    elif key == b"t":
        out(b"\x1b[!p\x1b[1;1HSOFT RESET")
    elif key == b"s":
        out(b"\x1b[r\x1b[2J\x1b[1;1H" +
            b"\r\n".join(f"history-{n:02}".encode() for n in range(48)))
    elif key == b"m":
        out(b"\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[>7u"
            b"\x1b[1;1HINPUT")
        received = read_through(b"GO")[:-2]
        out(b"\x1b[2J\x1b[1;1H" + b"\r\n".join(
            received.hex()[i:i+48].encode() for i in range(0, len(received.hex()), 48)))
    elif key == b"q":
        out(b"\x1b[4;7H\x1b[6n")
        cursor = read_through(b"R").removeprefix(b"\x1b[")
        answers = []
        for query in (18, 14, "14;2", 16, 19):
            out(f"\x1b[{query}t".encode())
            answers.append(read_through(b"t").removeprefix(b"\x1b[")[:-1])
        out(b"\x1b[2J\x1b[1;1H" + b"|".join([cursor, *answers]))
    elif key == b"z":
        report_size()
    elif key == b"e":
        break
