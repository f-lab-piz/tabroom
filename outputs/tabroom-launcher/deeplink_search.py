import json
import re
import unicodedata
from pathlib import Path


DIRECTORY = Path(__file__).resolve().with_name('deeplinks')
CATALOG = json.loads((DIRECTORY / 'catalog.json').read_text(encoding='utf-8'))
IMAGE_NAMES = {page['id'] + '.jpg' for page in CATALOG}
COMMON_WORDS = {'곳', '사이트', '페이지', '찾는', '찾아줘', '하는', '하고', '싶어', '사는', '보는', '수', '있는', '열어줘'}


def terms(value):
    return re.findall(r'[^\W_]+', unicodedata.normalize('NFKC', value).casefold())


def search(query):
    needle = [term for term in terms(query) if term not in COMMON_WORDS]
    if not needle:
        return []
    phrase = ''.join(needle)
    ranked = []
    for page in CATALOG:
        title = ' '.join(terms(page['title']))
        description = ' '.join(terms(page['description']))
        keywords = ' '.join(terms(page['keywords']))
        fields = ((title, 5), (description, 2), (keywords, 3))
        exact = max((weight for field, weight in fields if phrase in field.replace(' ', '')), default=0)
        word_scores = [max((weight for field, weight in fields if word in field), default=0) for word in needle]
        matches = sum(bool(score) for score in word_scores)
        if exact or (len(phrase) > 1 and matches * 3 >= len(needle) * 2):
            score = exact * 4 + sum(word_scores) + matches * 3
            ranked.append((score, page))
    ranked.sort(key=lambda row: -row[0])
    return [
        {
            'title': page['title'], 'url': page['url'], 'description': page['description'],
            'image': '/deeplinks/' + page['id'] + '.jpg',
        }
        for _, page in ranked[:5]
    ]
