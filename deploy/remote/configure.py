"""Initialize a Tabroom gateway and launch the local Chrome connection tab."""
from argparse import ArgumentParser
from getpass import getpass
import json
import os
from pathlib import Path
from secrets import token_urlsafe
from subprocess import run
from uuid import UUID


def init(account_profile):
    if keys.exists():
        raise SystemExit('Gateway configuration already exists.')
    password = getpass('New portal access code: ')
    if not 12 <= len(password) <= 140 or len(password.encode()) > 140:
        raise SystemExit('Use an access code between 12 characters and 140 UTF-8 bytes.')
    keys.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    settings = {
        'password': password,
        'profileKey': token_urlsafe(32),
        'signingKey': token_urlsafe(32),
        'hostSecret': token_urlsafe(32),
        'accountProfile': str(account_profile),
    }
    with os.fdopen(os.open(keys, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as output:
        json.dump(settings, output)
    print('Gateway configuration created.')


def open_mac():
    secret = json.loads(keys.read_text())['hostSecret']
    url = 'http://127.0.0.1:18840/portal.html?mac-bridge=1#' + secret
    run(['open', '-g', '-a', 'Google Chrome', url], check=True)


if __name__ == '__main__':
    keys = Path.home() / 'Library/Application Support/Tabroom/remote/keys.json'
    parser = ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    setup = commands.add_parser('init')
    setup.add_argument('account_profile', type=UUID, help='Home Chrome extension profile UUID')
    commands.add_parser('open-mac')
    args = parser.parse_args()
    if args.command == 'init':
        init(args.account_profile)
    else:
        open_mac()
