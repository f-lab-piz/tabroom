import base64
import hashlib
import json
import sys
from tempfile import NamedTemporaryFile
from pathlib import Path

launcher = Path(__file__).resolve().parent
key = json.loads((launcher.parent / 'tabroom/manifest.json').read_text())['key']
digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
extension_id = ''.join(chr(97 + int(char, 16)) for char in digest)
support = Path.home() / 'Library/Application Support'
host_dir = support / 'Tabroom'
host_dir.mkdir(parents=True, exist_ok=True)


def install(path, data, mode):
    with NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        stream.write(data)
        temporary = Path(stream.name)
    try:
        temporary.chmod(mode)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


directories = [support / 'Google/Chrome/NativeMessagingHosts',
               support / 'Google/ChromeForTesting/NativeMessagingHosts']
if len(sys.argv) > 1:
    directories.append(Path(sys.argv[1]).resolve() / 'NativeMessagingHosts')
for name, filename, description in [
    ('com.tabroom.chrome_cpu', 'chrome_cpu.py', '탭룸 Chrome CPU 측정'),
    ('com.tabroom.agent', 'chrome_agent.py', '탭룸 브라우저 에이전트'),
    ('com.tabroom.window_visibility', 'window_visibility.py', '탭룸 미리보기 창 가림 감지'),
]:
    host = host_dir / filename
    source = (launcher / filename).read_bytes().split(b'\n', 1)[1]
    # Chrome can launch native hosts with a smaller PATH than the terminal.
    install(host, b'#!' + sys.executable.encode() + b'\n' + source, 0o700)
    config = {
        'name': name, 'description': description, 'type': 'stdio', 'path': str(host),
        'allowed_origins': ['chrome-extension://' + extension_id + '/'],
    }
    for directory in directories:
        directory.mkdir(parents=True, exist_ok=True)
        install(directory / (name + '.json'), json.dumps(config, ensure_ascii=False).encode(), 0o600)
print('탭룸 Chrome 연결이 설치되었습니다.')
