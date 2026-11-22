#!/usr/bin/env python3
"""Report which preview windows are covered by ordinary desktop windows."""
from __future__ import annotations

import ctypes as c
from dataclasses import dataclass
import json
import os
import struct
import sys


@dataclass(frozen=True)
class Window:
    frame: tuple
    chrome_bounds: tuple | None = None
    opaque: bool = False
    alternate_chrome_bounds: tuple | None = None


def intersects(rect, cover):
    left = max(rect[0], cover[0])
    top = max(rect[1], cover[1])
    right = min(rect[2], cover[2])
    bottom = min(rect[3], cover[3])
    return (left, top, right, bottom) if left < right and top < bottom else None


def subtract(rect, cover):
    common = intersects(rect, cover)
    if not common:
        return [rect]
    l, t, r, b = rect
    cl, ct, cr, cb = common
    return [part for part in ((l, t, cl, b), (cr, t, r, b),
                              (cl, t, cr, ct), (cl, cb, cr, b))
            if part[0] < part[2] and part[1] < part[3]]


def matches_bounds(actual, expected):
    return actual is not None and all(abs(a - b) <= 3 for a, b in zip(actual, expected))


def covered_windows(targets, windows):
    covered = []
    for key, bounds in targets.items():
        matches = [i for i, window in enumerate(windows)
                   if matches_bounds(window.chrome_bounds, bounds)
                   or matches_bounds(window.alternate_chrome_bounds, bounds)]
        if len(matches) != 1:
            continue
        index = matches[0]
        visible = [windows[index].frame]
        for window in windows[:index]:
            if window.opaque:
                visible = [part for rect in visible for part in subtract(rect, window.frame)]
                if not visible:
                    covered.append(key)
                    break
    return covered


def rect(left, top, width, height):
    return left, top, left + width, top + height


def mac_window_source():
    framework = '/System/Library/Frameworks/'
    cf = c.CDLL(framework + 'CoreFoundation.framework/CoreFoundation')
    cg = c.CDLL(framework + 'CoreGraphics.framework/CoreGraphics')
    pointer = c.c_void_p
    index_type = c.c_long
    number = c.c_double
    cg.CGWindowListCopyWindowInfo.argtypes = [c.c_uint32, c.c_uint32]
    cg.CGWindowListCopyWindowInfo.restype = pointer
    cf.CFArrayGetCount.argtypes = [pointer]
    cf.CFArrayGetCount.restype = index_type
    cf.CFArrayGetValueAtIndex.argtypes = [pointer, index_type]
    cf.CFArrayGetValueAtIndex.restype = pointer
    cf.CFDictionaryGetValue.argtypes = [pointer, pointer]
    cf.CFDictionaryGetValue.restype = pointer
    cf.CFNumberGetValue.argtypes = [pointer, c.c_int, pointer]
    cf.CFNumberGetValue.restype = c.c_bool
    cf.CFStringCreateWithCString.argtypes = [pointer, c.c_char_p, c.c_uint32]
    cf.CFStringCreateWithCString.restype = pointer
    cf.CFRelease.argtypes = [pointer]

    keys = {key: pointer.in_dll(cg, 'kCGWindow' + key)
            for key in ('Bounds', 'OwnerPID', 'Alpha', 'Layer')}
    fields = [cf.CFStringCreateWithCString(None, key, 0x08000100)
              for key in (b'X', b'Y', b'Width', b'Height')]
    browser_pid = os.getppid()

    def get_number(row, key):
        value = cf.CFDictionaryGetValue(row, key)
        result = number()
        return result.value if value and cf.CFNumberGetValue(value, 13, c.byref(result)) else None

    def snapshot():
        listing = cg.CGWindowListCopyWindowInfo(1 | 16, 0)
        if not listing:
            return []
        windows = []
        try:
            for index in range(cf.CFArrayGetCount(listing)):
                row = cf.CFArrayGetValueAtIndex(listing, index)
                if get_number(row, keys['Layer']) != 0:
                    continue
                bounds = cf.CFDictionaryGetValue(row, keys['Bounds'])
                if not bounds:
                    continue
                values = [get_number(bounds, field) for field in fields]
                if None in values or min(values[2:]) <= 0:
                    continue
                frame = rect(*values)
                chrome = get_number(row, keys['OwnerPID']) == browser_pid
                windows.append(Window(frame, frame if chrome else None,
                                      get_number(row, keys['Alpha']) == 1))
        finally:
            cf.CFRelease(listing)
        return windows

    return snapshot


def windows_window_source():
    from ctypes import wintypes as w

    user = c.WinDLL('user32', use_last_error=True)
    dwm = c.WinDLL('dwmapi', use_last_error=True)
    kernel = c.WinDLL('kernel32', use_last_error=True)

    def bind(dll, name, result, *args):
        fn = getattr(dll, name)
        fn.argtypes = args
        fn.restype = result
        return fn

    hwnd = w.HWND
    pointer = c.c_void_p
    set_dpi = bind(user, 'SetThreadDpiAwarenessContext', pointer, pointer)
    dpi_context = set_dpi(pointer(-4))
    if not dpi_context:
        return lambda: []
    get_top = bind(user, 'GetTopWindow', hwnd, hwnd)
    get_window = bind(user, 'GetWindow', hwnd, hwnd, w.UINT)
    is_visible = bind(user, 'IsWindowVisible', w.BOOL, hwnd)
    is_iconic = bind(user, 'IsIconic', w.BOOL, hwnd)
    get_rect = bind(user, 'GetWindowRect', w.BOOL, hwnd, c.POINTER(w.RECT))
    get_region = bind(user, 'GetWindowRgnBox', c.c_int, hwnd, c.POINTER(w.RECT))
    get_attr = bind(dwm, 'DwmGetWindowAttribute', c.c_long, hwnd, w.DWORD, pointer, w.DWORD)
    get_class = bind(user, 'GetClassNameW', c.c_int, hwnd, w.LPWSTR, c.c_int)
    get_style = bind(user, 'GetWindowLongW', c.c_long, hwnd, c.c_int)
    get_pid = bind(user, 'GetWindowThreadProcessId', w.DWORD, hwnd, c.POINTER(w.DWORD))
    get_monitor = bind(user, 'MonitorFromWindow', w.HMONITOR, hwnd, w.DWORD)
    primary = bind(user, 'MonitorFromPoint', w.HMONITOR, w.POINT, w.DWORD)(w.POINT(0, 0), 1)
    get_dpi = bind(user, 'GetDpiForWindow', w.UINT, hwnd)
    open_process = bind(kernel, 'OpenProcess', w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
    get_image = bind(kernel, 'QueryFullProcessImageNameW', w.BOOL, w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD))
    close_handle = bind(kernel, 'CloseHandle', w.BOOL, w.HANDLE)

    def chrome_process(pid):
        process = open_process(0x1000, False, pid)
        if not process:
            return False
        try:
            path = c.create_unicode_buffer(32768)
            size = w.DWORD(len(path))
            return get_image(process, 0, path, c.byref(size)) and os.path.basename(path.value).lower() == 'chrome.exe'
        finally:
            close_handle(process)

    def bounds(row):
        return row.left, row.top, row.right, row.bottom

    def snapshot():
        windows = []
        known_chrome = {}
        current = get_top(None)
        visited = set()
        while current and current not in visited:
            visited.add(current)
            handle = current
            current = get_window(handle, 2)  # GW_HWNDNEXT
            if not is_visible(handle) or is_iconic(handle):
                continue
            cloaked = w.DWORD()
            if get_attr(handle, 14, c.byref(cloaked), c.sizeof(cloaked)) != 0 or cloaked.value:
                continue
            frame = w.RECT()
            if get_attr(handle, 9, c.byref(frame), c.sizeof(frame)) != 0:
                continue
            visible = bounds(frame)
            if visible[0] >= visible[2] or visible[1] >= visible[3]:
                continue
            name = c.create_unicode_buffer(64)
            get_class(handle, name, len(name))
            candidate = alternate = None
            if name.value == 'Chrome_WidgetWin_1':
                pid = w.DWORD()
                get_pid(handle, c.byref(pid))
                if pid.value not in known_chrome:
                    known_chrome[pid.value] = chrome_process(pid.value)
                # Chrome screen coordinates are scaled around the primary display's origin.
                # An uncertain conversion on another display leaves the preview active.
                scale = get_dpi(handle) / 96
                raw = w.RECT()
                if known_chrome[pid.value] and get_monitor(handle, 0) == primary and scale and get_rect(handle, c.byref(raw)):
                    candidate = tuple(value / scale for value in bounds(raw))
                    alternate = tuple(value / scale for value in visible)
            style = get_style(handle, -20)
            # Exclude transparent, layered, tool, no-activate and shaped windows.
            opaque = not style & (0x20 | 0x80000 | 0x80 | 0x08000000) and not get_region(handle, c.byref(w.RECT()))
            windows.append(Window(visible, candidate, opaque, alternate))
        return windows

    return snapshot


def read_targets(message):
    if not isinstance(message, dict) or message.get('type') != 'visibility':
        return {}
    windows = message.get('windows')
    if not isinstance(windows, list) or len(windows) > 32:
        return {}
    targets = {}
    for item in windows:
        if not isinstance(item, dict):
            continue
        key = item.get('id')
        numbers = [item.get(field) for field in ('left', 'top', 'width', 'height')]
        if type(key) is int and all(type(value) is int and abs(value) < 100000 for value in numbers) and min(numbers[2:]) > 0:
            targets[key] = rect(*numbers)
    return targets


def serve():
    if sys.platform == 'darwin':
        snapshot = mac_window_source()
    elif sys.platform == 'win32':
        snapshot = windows_window_source()
    else:
        snapshot = lambda: []
    while header := sys.stdin.buffer.read(4):
        if len(header) != 4:
            return
        length, = struct.unpack('=I', header)
        if length > 8192:
            return
        payload = sys.stdin.buffer.read(length)
        if len(payload) != length:
            return
        targets = read_targets(json.loads(payload))
        reply = json.dumps({'covered': covered_windows(targets, snapshot()) if targets else []}).encode()
        sys.stdout.buffer.write(struct.pack('=I', len(reply)) + reply)
        sys.stdout.buffer.flush()


if __name__ == '__main__':
    serve()
