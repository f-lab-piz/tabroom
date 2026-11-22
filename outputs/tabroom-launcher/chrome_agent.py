#!/usr/bin/env python3
"""Connect the installed Tabroom extension to its private local agent socket."""
import json
import os
from pathlib import Path
import socket
import struct
import sys
import threading

MAX_FROM_CHROME = 32 * 1024 * 1024
MAX_TO_CHROME = 1024 * 1024
default = Path.home() / 'Library/Application Support/Tabroom/agent.sock'
path = os.environ.get('TABROOM_AGENT_SOCKET', str(default))


def serve(connection):
    def forward_chrome():
        try:
            while header := sys.stdin.buffer.read(4):
                (length,) = struct.unpack('=I', header)
                if length > MAX_FROM_CHROME:
                    return
                payload = sys.stdin.buffer.read(length)
                if len(payload) != length:
                    return
                message = json.loads(payload)
                connection.sendall(json.dumps(message, separators=(',', ':')).encode() + b'\n')
        except (OSError, ValueError, struct.error):
            pass
        finally:
            try:
                connection.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    threading.Thread(target=forward_chrome, daemon=True).start()
    with connection.makefile('rb') as incoming:
        while line := incoming.readline(MAX_TO_CHROME + 1):
            if len(line) > MAX_TO_CHROME or not line.endswith(b'\n'):
                return
            payload = line[:-1]
            sys.stdout.buffer.write(struct.pack('=I', len(payload)) + payload)
            sys.stdout.buffer.flush()


if __name__ == '__main__':
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(path)
            serve(connection)
    except (BrokenPipeError, ConnectionResetError, FileNotFoundError, ConnectionRefusedError):
        pass
