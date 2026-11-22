#!/usr/bin/env python3
"""Serve CPU counters for the Chrome instance that opened this native port."""
import json
import os
import struct
import subprocess
import sys
import time
import uuid

BROWSER = ('/Google Chrome.app/Contents/MacOS/Google Chrome',
           '/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')


def snapshot():
    table = subprocess.check_output(
        ['/bin/ps', '-Aww', '-o', 'pid=,ppid=,time=,comm='],
        text=True, errors='replace', env={**os.environ, 'LC_ALL': 'C'},
    )
    processes = {}
    for line in table.splitlines():
        fields = line.split(None, 3)
        if len(fields) == 4:
            pid, parent, cpu, executable = fields
            processes[int(pid)] = (int(parent), cpu, executable)
    return processes


def browser_pid(processes, caller):
    while caller in processes:
        parent, _, executable = processes[caller]
        if executable.endswith(BROWSER):
            return caller
        if caller == parent:
            break
        caller = parent
    raise ValueError('The native host must be started by Google Chrome')


def cpu_times(processes, root):
    prefix = processes[root][2].rsplit('/Contents/', 1)[0] + '/Contents/'
    children = {}
    for pid, (parent, _, executable) in processes.items():
        if executable.startswith(prefix):
            children.setdefault(parent, []).append(pid)
    result = {}
    stack = [root]
    while stack:
        pid = stack.pop()
        elapsed = 0.0
        for field in processes[pid][1].split(':'):
            elapsed = elapsed * 60 + float(field)
        result[pid] = elapsed
        stack.extend(children.get(pid, []))
    return result


def serve():
    previous = {}
    generation = uuid.uuid4().hex
    total = 0
    while True:
        header = sys.stdin.buffer.read(4)
        if len(header) != 4:
            return
        length, = struct.unpack('=I', header)
        if length > 256:
            return
        payload = sys.stdin.buffer.read(length)
        if len(payload) != length or json.loads(payload) != {'type': 'sample'}:
            return
        processes = snapshot()
        root = browser_pid(processes, os.getppid())
        current = cpu_times(processes, root)
        if previous:
            total += sum(max(0, value - previous.get(pid, 0)) for pid, value in current.items())
        previous = current
        message = json.dumps({'time': time.monotonic_ns() / 1e6, 'cpuSeconds': total,
                              'generation': generation, 'processes': len(current)}).encode()
        sys.stdout.buffer.write(struct.pack('=I', len(message)) + message)
        sys.stdout.buffer.flush()


if __name__ == '__main__':
    serve()
