from pathlib import Path
import json
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.parse import quote
from urllib.request import urlopen, Request

launcher = Path(__file__).resolve().parent
bundle = launcher.parent / 'tabroom'
portal = 'http://127.0.0.1:18840/'
work = Path.home() / 'Library/Application Support/Tabroom'
profile = work / 'hmngikndankgldefcihbegdepaomgnlb/chrome-profile'
work.mkdir(parents=True, exist_ok=True)


def launch(name, args):
    with (work / (name + '.log')).open('ab') as log:
        subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)


def ready():
    try:
        with urlopen(portal + 'health', timeout=1) as response:
            return response.read() == b'tabroom-portal-5'
    except URLError:
        return False


if not ready():
    launch('portal', [sys.executable, str(launcher / 'server.py')])
    for _ in range(30):
        time.sleep(0.1)
        if ready():
            break
    else:
        sys.exit('채팅 서버를 열 수 없습니다. 18840 포트 사용 여부를 확인하세요.')

if '--regular' in sys.argv:
    subprocess.run([sys.executable, str(launcher / 'install_cpu.py')], check=True)
    subprocess.run(['open', '-a', 'Google Chrome', portal], check=True)
    sys.exit()

binary = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
candidates = [Path('/Applications') / binary, Path.home() / 'Applications' / binary]
candidates.extend(sorted(Path.home().glob('Library/Caches/ms-playwright/chromium-*/chrome-mac*/' + binary), reverse=True))
chrome = next((p for p in candidates if p.is_file()), None)
if not chrome:
    sys.exit('Google Chrome for Testing을 찾을 수 없습니다. 일반 Chrome 탭룸 열기.command를 사용할 수 있습니다.')
profile.mkdir(parents=True, exist_ok=True)
subprocess.run([sys.executable, str(launcher / 'install_cpu.py'), str(profile)], check=True)
if (profile / 'SingletonLock').is_symlink() and (profile / 'DevToolsActivePort').exists():
    port = (profile / 'DevToolsActivePort').read_text().splitlines()[0]
    api = 'http://127.0.0.1:' + port
    try:
        with urlopen(api + '/json/list', timeout=2) as response:
            tab = next((t for t in json.load(response) if t['url'].split('#')[0] == portal), None)
        route = '/json/activate/' + tab['id'] if tab else '/json/new?' + quote(portal, safe='')
        with urlopen(Request(api + route, method='GET' if tab else 'PUT'), timeout=3):
            sys.exit()
    except URLError:
        pass
args = ['--user-data-dir=' + str(profile), '--load-extension=' + str(bundle),
        '--disable-extensions-except=' + str(bundle), '--no-first-run', '--no-default-browser-check',
        '--disable-background-media-suspend', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        '--disable-features=BackgroundVideoTrackOptimization,BackgroundVideoPauseOptimization',
        '--autoplay-policy=no-user-gesture-required', '--use-mock-keychain', '--disable-background-networking',
        '--window-size=1320,1000', '--remote-debugging-port=0']
launch('chrome', [str(chrome), *args, *[portal + 'demo/' + s + '.html' for s in ('motion','lines','orbit')], portal])

# Activate each newly opened demo once so Chrome initializes its media element.
for _ in range(60):
    try:
        port = (profile / 'DevToolsActivePort').read_text().splitlines()[0]
        api = 'http://127.0.0.1:' + port
        with urlopen(api + '/json/list', timeout=1) as response:
            pages = json.load(response)
        demos = [p for p in pages if p.get('type') == 'page' and p['url'].startswith(portal + 'demo/')]
        chat = next((p for p in pages if p['url'] == portal), None)
        if chat and len(demos) == 3:
            for tab in demos + [chat]:
                with urlopen(api + '/json/activate/' + tab['id'], timeout=2):
                    time.sleep(0.2)
            break
    except (OSError, ValueError, IndexError):
        pass
    time.sleep(0.2)
