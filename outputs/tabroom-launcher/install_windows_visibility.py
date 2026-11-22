"""Register the preview-visibility host for Chrome on Windows."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys


def install():
    if os.name != 'nt':
        raise SystemExit('Run this installer on Windows.')
    import winreg

    if Path(sys.executable).name.lower() == 'pythonw.exe':
        raise SystemExit('Run this installer with python.exe.')
    launcher = Path(__file__).resolve().parent
    key = json.loads((launcher.parent / 'tabroom/manifest.json').read_text(encoding='utf-8'))['key']
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    extension = ''.join(chr(97 + int(char, 16)) for char in digest)
    directory = Path(os.environ['LOCALAPPDATA']) / 'Tabroom'
    directory.mkdir(parents=True, exist_ok=True)
    host = directory / 'window_visibility.cmd'
    shutil.copyfile(launcher / 'window_visibility.py', directory / 'window_visibility.py')
    python = sys.executable.replace('%', '%%')
    host.write_text(f'@echo off\nsetlocal DisableDelayedExpansion\n"{python}" "%~dp0window_visibility.py"\n',
                    encoding='mbcs')
    name = 'com.tabroom.window_visibility'
    manifest = directory / (name + '.json')
    manifest.write_text(json.dumps({
        'name': name, 'description': 'Tabroom preview window visibility', 'type': 'stdio',
        'path': str(host), 'allowed_origins': ['chrome-extension://' + extension + '/'],
    }), encoding='utf-8')
    registry = r'SOFTWARE\Google\Chrome\NativeMessagingHosts' + '\\' + name
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, registry) as key_handle:
        winreg.SetValueEx(key_handle, '', 0, winreg.REG_SZ, str(manifest))
    print('Tabroom preview visibility host registered for the current user.')


if __name__ == '__main__':
    install()
