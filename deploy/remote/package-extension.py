from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile
import argparse
import json

parser = argparse.ArgumentParser(description='Build the remote Tabroom Chrome extension ZIP.')
parser.add_argument('origin', help='HTTPS origin of the remote portal, including any port')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
outputs = root / 'outputs'
source = outputs / 'tabroom'
origin = args.origin
url = urlsplit(origin)
if url.scheme != 'https' or url.hostname is None or url.path or url.query or url.fragment or url.username or url.password:
    raise SystemExit('An HTTPS portal origin is required.')
match = f'https://{url.hostname}/*'
manifest = json.loads((source / 'manifest.json').read_text())
manifest['version'] = '0.6.26'
manifest['externally_connectable']['matches'] = [match]
manifest['host_permissions'] = [match]
for resource in manifest['web_accessible_resources']:
    resource['matches'] = [match]

local_only = {'mac-bridge.html', 'mac-bridge.js'}
names = {p.name for p in source.iterdir() if p.is_file()
         and p.suffix in ('.js', '.html', '.css', '.json') and p.name not in local_only}
for directory in ('aside', 'interactive-ui'):
    names.update(p.relative_to(source).as_posix() for p in (source / directory).iterdir()
                 if p.is_file() and p.suffix in ('.js', '.mjs', '.css', '.md'))
target = outputs / 'tabroom-extension.zip'
temporary = target.with_suffix('.tmp')
with ZipFile(temporary, 'w', compression=ZIP_DEFLATED) as archive:
    for name in sorted(names):
        if name == 'manifest.json':
            data = json.dumps(manifest,ensure_ascii=False,indent=2)
        elif name == 'remote-config.js':
            data = (source / name).read_text().replace("export const remoteOrigin = '';",
                "export const remoteOrigin = " + json.dumps(origin) + ";")
        elif name == 'index.html':
            data = (source / name).read_text().replace('http://127.0.0.1:18840/',origin+'/')
        else:
            data = (source / name).read_bytes()
        archive.writestr('tabroom/' + name, data)
with ZipFile(temporary) as archive:
    assert archive.testzip() is None
temporary.replace(target)
print(f'Chrome extension {manifest["version"]}: {len(names)} files, {target.stat().st_size:,} bytes')
