"""Omsk Guide: standard-library HTTP server, SQLite persistence, no dependencies.
Run: python server.py. Admin provisioning: python server.py --create-admin.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import getpass
import hashlib
import hmac
import html
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
from collections import defaultdict, deque
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import URLError
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get('OMSK_DB', str(ROOT / 'private' / 'omsk.sqlite3')))
PAGES = {'index.html', 'places.html', 'routes.html', 'guide.html', 'events.html',
         'journal.html', 'reviews.html', 'about.html', 'admin.html'}
UTC = dt.timezone.utc
OMSK = dt.timezone(dt.timedelta(hours=6))
SESSION_SECONDS = 30 * 24 * 3600
MAX_BODY = 8 * 1024 * 1024
DRAMA_URL = 'https://omskdrama.ru/affiche/'
WEATHER_URL = ('https://api.open-meteo.com/v1/forecast?latitude=54.99&longitude=73.37'
               '&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m'
               '&daily=sunrise,sunset&forecast_days=1&timezone=Asia%2FOmsk')
CAT_IDS = {'walk', 'food', 'coffee', 'culture', 'bar', 'family'}
_rate_lock = threading.Lock()
_rate = defaultdict(deque)
_cache_locks = {'weather': threading.Lock(), 'events': threading.Lock()}


def now_iso():
    return dt.datetime.now(UTC).isoformat(timespec='seconds')


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def connect():
    db = sqlite3.connect(DB_PATH, timeout=15, factory=ClosingConnection)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db


def initialize():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
          name TEXT NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL,
          avatar TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user', created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          csrf TEXT NOT NULL, expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reviews (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), place_id TEXT NOT NULL,
          rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), text TEXT NOT NULL,
          photos TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS diary (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), place_id TEXT NOT NULL,
          text TEXT NOT NULL, photos TEXT NOT NULL DEFAULT '[]', visited TEXT NOT NULL,
          created TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS user_state (user_id TEXT PRIMARY KEY REFERENCES users(id), payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS suggestions (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', created TEXT NOT NULL, place_id TEXT);
        CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS cache (name TEXT PRIMARY KEY, payload TEXT NOT NULL, updated REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS reviews_status ON reviews(status, created);
        CREATE INDEX IF NOT EXISTS diary_user ON diary(user_id, deleted);
        ''')
        if not db.execute('SELECT 1 FROM places LIMIT 1').fetchone():
            seed = json.loads((ROOT / 'data' / 'places.json').read_text(encoding='utf-8'))
            db.executemany('INSERT INTO places VALUES(?,?,?)',
                           [(p['id'], json.dumps(p, ensure_ascii=False), now_iso()) for p in seed])
        db.execute('DELETE FROM sessions WHERE expires < ?', (time.time(),))


class ApiError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def field(data, key, minimum=0, maximum=200, default=''):
    value = data.get(key, default)
    if not isinstance(value, str):
        raise ApiError(400, f'Invalid text field: {key}')
    value = value.strip()
    if not minimum <= len(value) <= maximum:
        raise ApiError(400, f'Invalid length: {key} ({minimum}–{maximum})')
    return value


def integer(data, key, low, high, default=None):
    value = data.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value or not low <= value <= high:
        raise ApiError(400, f'Invalid number: {key}')
    return int(value)


def safe_url(value, allow_empty=True):
    if value == '' and allow_empty:
        return ''
    if not isinstance(value, str) or len(value) > 2000:
        raise ApiError(400, 'Invalid URL')
    parsed = urlparse(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ApiError(400, 'Use an HTTPS URL')
    return value


def image_data(value, maximum=1024 * 1024):
    if value == '':
        return ''
    if not isinstance(value, str) or len(value) > maximum * 1.4 + 100:
        raise ApiError(400, 'Image is too large')
    match = re.fullmatch(r'data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)', value)
    if not match:
        raise ApiError(400, 'Only JPEG, PNG and WebP images are allowed')
    try:
        raw = base64.b64decode(match[2], validate=True)
    except ValueError:
        raise ApiError(400, 'Invalid image encoding')
    if len(raw) > maximum:
        raise ApiError(400, 'Image is too large')
    valid = ((match[1] == 'jpeg' and raw.startswith(b'\xff\xd8\xff')) or
             (match[1] == 'png' and raw.startswith(b'\x89PNG\r\n\x1a\n')) or
             (match[1] == 'webp' and raw.startswith(b'RIFF') and raw[8:12] == b'WEBP'))
    if not valid:
        raise ApiError(400, 'Image content does not match its type')
    return value


def photos_field(data):
    photos = data.get('photos', [])
    if not isinstance(photos, list) or len(photos) > 3:
        raise ApiError(400, 'Up to three images are allowed')
    return [image_data(photo) for photo in photos]


def password_hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1, dklen=32).hex()


def public_user(row):
    return {k: row[k] for k in ('id', 'email', 'name', 'avatar', 'role')}


def valid_email(value):
    return bool(re.fullmatch(r'[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+', value))


def limited(key, count=12, seconds=600):
    with _rate_lock:
        now = time.monotonic()
        bucket = _rate[key]
        while bucket and bucket[0] <= now - seconds:
            bucket.popleft()
        if len(bucket) >= count:
            raise ApiError(429, 'Too many attempts. Please try again later.')
        bucket.append(now)
        if len(_rate) > 5000:
            for old_key in list(_rate):
                if not _rate[old_key] or _rate[old_key][-1] < now - seconds:
                    del _rate[old_key]


def get_places():
    with connect() as db:
        return [json.loads(row['payload']) for row in db.execute('SELECT payload FROM places ORDER BY rowid')]


def require_place(value, site=False):
    if site and value == 'site':
        return value
    if not isinstance(value, str):
        raise ApiError(400, 'Choose a place')
    with connect() as db:
        if not db.execute('SELECT 1 FROM places WHERE id=?', (value,)).fetchone():
            raise ApiError(400, 'Place was not found')
    return value


def validate_place(data, existing_id=None):
    pid = existing_id or field(data, 'id', 1, 70)
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', pid):
        raise ApiError(400, 'Invalid place identifier')
    cats = data.get('cats')
    if not isinstance(cats, list) or not cats or not set(cats) <= CAT_IDS:
        raise ApiError(400, 'Choose valid categories')
    rating = data.get('rating', 0)
    if isinstance(rating, bool) or not isinstance(rating, (float, int)) or not 0 <= rating <= 5:
        raise ApiError(400, 'Rating must be between 0 and 5')
    result = dict(id=pid, ru=field(data, 'ru', 2, 150), en=field(data, 'en', 2, 150),
                  descRu=field(data, 'descRu', 5, 1500), descEn=field(data, 'descEn', 5, 1500),
                  cats=list(dict.fromkeys(cats)), rating=rating,
                  price=integer(data, 'price', 0, 100000), tags=field(data, 'tags', 0, 500),
                  minutes=integer(data, 'minutes', 10, 480, 50), indoor=bool(data.get('indoor', False)),
                  image=field(data, 'image', 0, 30, 'walk'))
    photo = data.get('photo', '')
    result['photo'] = image_data(photo) if isinstance(photo, str) and photo.startswith('data:') else safe_url(photo)
    lat, lng = data.get('lat'), data.get('lng')
    if lat in ('', None) and lng in ('', None):
        result.update(lat=None, lng=None)
    elif (isinstance(lat, (int, float)) and not isinstance(lat, bool) and -90 <= lat <= 90 and
          isinstance(lng, (int, float)) and not isinstance(lng, bool) and -180 <= lng <= 180):
        result.update(lat=lat, lng=lng)
    else:
        raise ApiError(400, 'Invalid coordinates')
    return result


def get_cache(key):
    with connect() as db:
        row = db.execute('SELECT * FROM cache WHERE name=?', (key,)).fetchone()
        return (json.loads(row['payload']), row['updated']) if row else (None, 0)


def put_cache(key, payload):
    with connect() as db:
        db.execute('INSERT OR REPLACE INTO cache VALUES(?,?,?)',
                   (key, json.dumps(payload, ensure_ascii=False), time.time()))


def fetch_bytes(url, maximum=3 * 1024 * 1024):
    req = Request(url, headers={'User-Agent': 'OmskGuide55/1.0 (+https://t.me/baerovich)'})
    with urlopen(req, timeout=10) as response:
        data = response.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError('Remote response too large')
    return data


def weather():
    with _cache_locks['weather']:
        cached, timestamp = get_cache('weather')
        if cached and time.time() - timestamp < 600:
            return {**cached, 'stale': False}
        try:
            data = json.loads(fetch_bytes(WEATHER_URL))
            current = data['current']
            if not isinstance(current.get('temperature_2m'), (int, float)):
                raise ValueError('Invalid weather response')
            result = {'current': current, 'daily': data.get('daily', {}), 'updated': now_iso(),
                      'source': 'https://open-meteo.com/', 'timezone': 'Asia/Omsk'}
            put_cache('weather', result)
            return {**result, 'stale': False}
        except (URLError, TimeoutError, OSError, ValueError, KeyError):
            if cached and time.time() - timestamp < 86400:
                return {**cached, 'stale': True}
            raise ApiError(503, 'Weather provider is temporarily unavailable')


def plain(value):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]*>', '', value))).strip()


def parse_drama(source):
    """Parse only known schedule fields; fail closed if the source markup changes."""
    year_match = re.search(r'data-month="\d+"\s+data-year="(\d{4})"', source)
    if not year_match:
        raise ValueError('Schedule year missing')
    year = int(year_match[1])
    months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа',
              'сентября', 'октября', 'ноября', 'декабря']
    items = re.split(r'<div\s+class="item"\s+data-name="', source)[1:]
    events = []
    for item in items[:100]:
        title = html.unescape(item.split('"', 1)[0])
        day = re.search(r'class="day">(\d{1,2})<', item)
        month = re.search(r'class="other-month">([^<]+)<', item)
        hour = re.search(r'class="other-time">(.*?)</div>', item, re.S)
        link = re.search(r'class="absolute-link"', item)
        urls = re.findall(r'href="(/poster/[^"#]+)"', item)
        if not (title and day and month and hour and urls and month[1] in months):
            continue
        tm = plain(hour[1])
        if not re.fullmatch(r'\d{1,2}:\d{2}', tm):
            continue
        month_number = months.index(month[1]) + 1
        # The selected schedule is the first month; a new January is already marked with its year.
        try:
            starts = dt.datetime(year, month_number, int(day[1]), *map(int, tm.split(':')), tzinfo=OMSK)
        except ValueError:
            continue
        url = 'https://omskdrama.ru' + urls[0]
        uid = 'drama-' + hashlib.sha256((title + starts.isoformat()).encode()).hexdigest()[:16]
        age = re.search(r'class="age"><span>([^<]+)', item)
        events.append({'id': uid, 'title': title, 'titleEn': title, 'date': starts.isoformat(),
                       'venue': 'Омский театр драмы', 'venueEn': 'Omsk Drama Theatre',
                       'description': age[1] if age else '', 'descriptionEn': age[1] if age else '',
                       'url': url, 'source': DRAMA_URL, 'price': None, 'imported': True})
    if not events:
        raise ValueError('No schedule entries found')
    return list({event['id']: event for event in events}.values())


def events_feed():
    with _cache_locks['events']:
        cached, timestamp = get_cache('events')
        stale = False
        if not cached or time.time() - timestamp >= 3600:
            try:
                imported = parse_drama(fetch_bytes(DRAMA_URL).decode('utf-8'))
                cached = {'events': imported, 'updated': now_iso()}
                put_cache('events', cached)
            except (URLError, TimeoutError, OSError, ValueError, UnicodeError):
                stale = True
        with connect() as db:
            manual = [json.loads(r[0]) for r in db.execute('SELECT payload FROM events WHERE archived=0')]
        data = (cached or {}).get('events', []) + manual
        today = dt.datetime.now(OMSK).date().isoformat()
        data = [event for event in data if str(event.get('date', ''))[:10] >= today]
        data.sort(key=lambda event: event['date'])
        return {'events': data, 'updated': (cached or {}).get('updated'), 'stale': stale,
                'source': DRAMA_URL, 'sourceAvailable': bool(cached)}


class Handler(BaseHTTPRequestHandler):
    server_version = 'OmskGuide'
    protocol_version = 'HTTP/1.1'

    def log_message(self, format, *args):
        # No form payloads, cookies or authorization material in logs.
        print(f'{self.client_address[0]} {self.command} {urlparse(self.path).path} {args[1] if len(args)>1 else ""}')

    def headers_common(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; "
                         "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                         "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; "
                         "connect-src 'self'; media-src 'self' blob:; object-src 'none'; "
                         "base-uri 'self'; form-action 'self'; frame-ancestors 'none'")

    def send_json(self, payload, status=200, cookie=None):
        raw = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.headers_common()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self):
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            raise ApiError(415, 'Use application/json')
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            raise ApiError(400, 'Invalid request length')
        if not 0 < length <= MAX_BODY:
            self.close_connection = True
            raise ApiError(413, 'Request is too large or empty')
        try:
            payload = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError):
            raise ApiError(400, 'Invalid JSON')
        if not isinstance(payload, dict):
            raise ApiError(400, 'Expected a JSON object')
        return payload

    def check_origin(self):
        if self.headers.get('X-Requested-With') != 'OmskGuide':
            raise ApiError(403, 'Same-origin request required')
        origin = self.headers.get('Origin')
        if origin and urlparse(origin).netloc.lower() != self.headers.get('Host', '').lower():
            raise ApiError(403, 'Cross-origin requests are not allowed')
        if self.headers.get('Sec-Fetch-Site') in ('cross-site', 'same-site'):
            raise ApiError(403, 'Cross-origin requests are not allowed')

    def session(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
        except Exception:
            return None
        if 'omsk_session' not in cookie:
            return None
        token = cookie['omsk_session'].value
        if not re.fullmatch(r'[A-Za-z0-9_-]{40,100}', token):
            return None
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with connect() as db:
            row = db.execute('SELECT u.*,s.csrf,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id '
                             'WHERE s.token_hash=? AND s.expires>?', (token_hash, time.time())).fetchone()
        return row

    def require_user(self, admin=False):
        user = self.session()
        if not user:
            raise ApiError(401, 'Please sign in first')
        if admin and user['role'] != 'admin':
            raise ApiError(403, 'Administrator access required')
        if self.command != 'GET' and not hmac.compare_digest(self.headers.get('X-CSRF-Token', ''), user['csrf']):
            raise ApiError(403, 'Session token missing or expired. Refresh the page.')
        return user

    def cookie(self, token='', max_age=SESSION_SECONDS):
        secure = '; Secure' if os.environ.get('SECURE_COOKIES') == '1' else ''
        return f'omsk_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}'

    def sign_in(self, user):
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
        old = self.session()
        with connect() as db:
            if old:
                db.execute('DELETE FROM sessions WHERE token_hash=?', (old['token_hash'],))
            db.execute('INSERT INTO sessions VALUES(?,?,?,?)',
                       (hashlib.sha256(token.encode()).hexdigest(), user['id'], csrf, time.time() + SESSION_SECONDS))
        self.send_json({'user': public_user(user), 'csrf': csrf}, cookie=self.cookie(token))

    def do_GET(self):
        try:
            path = urlparse(self.path).path
            if path.startswith('/api/'):
                self.api_get(path)
            else:
                self.static(path)
        except ApiError as error:
            self.send_json({'error': error.message}, error.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.send_json({'error': 'Internal server error'}, 500)

    def do_POST(self):
        try:
            self.check_origin()
            path = urlparse(self.path).path
            data = self.read_json()
            self.api_post(path, data)
        except ApiError as error:
            # An early origin/size rejection can leave an unread body on the socket.
            self.close_connection = True
            self.send_json({'error': error.message}, error.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.send_json({'error': 'Internal server error'}, 500)

    def static(self, path):
        name = unquote(path).lstrip('/') or 'index.html'
        if '\\' in name or '\x00' in name:
            raise ApiError(404, 'Not found')
        file = (ROOT / name).resolve()
        if name not in PAGES:
            asset_root = (ROOT / 'assets').resolve()
            if not file.is_relative_to(asset_root) or file.suffix.lower() not in {'.js', '.css', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.woff2'}:
                raise ApiError(404, 'Not found')
        if not file.is_file() or not file.is_relative_to(ROOT):
            raise ApiError(404, 'Not found')
        raw = file.read_bytes()
        self.send_response(200)
        self.headers_common()
        mime = mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
        if file.suffix in {'.js', '.css', '.html'}:
            mime += '; charset=utf-8'
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(raw)

    def api_get(self, path):
        if path == '/api/session':
            user = self.session()
            return self.send_json({'user': public_user(user) if user else None,
                                   'csrf': user['csrf'] if user else None})
        if path == '/api/places':
            return self.send_json({'places': get_places()})
        if path == '/api/weather':
            return self.send_json(weather())
        if path == '/api/events':
            return self.send_json(events_feed())
        if path == '/api/reviews':
            user = self.session()
            with connect() as db:
                rows = db.execute('SELECT r.*,u.name,u.avatar FROM reviews r JOIN users u ON r.user_id=u.id '
                                  "WHERE r.status='approved' OR (r.user_id=? AND r.status!='deleted') ORDER BY r.created DESC LIMIT 200",
                                  (user['id'] if user else '',)).fetchall()
            return self.send_json({'reviews': [{**dict(row), 'photos': json.loads(row['photos'])} for row in rows]})
        if path == '/api/state':
            user = self.require_user()
            with connect() as db:
                row = db.execute('SELECT payload FROM user_state WHERE user_id=?', (user['id'],)).fetchone()
            return self.send_json({'state': json.loads(row[0]) if row else {}})
        if path == '/api/diary':
            user = self.require_user()
            with connect() as db:
                rows = db.execute('SELECT * FROM diary WHERE user_id=? AND deleted=0 ORDER BY visited DESC,created DESC', (user['id'],)).fetchall()
            return self.send_json({'entries': [{**dict(row), 'photos': json.loads(row['photos'])} for row in rows]})
        if path == '/api/suggestions':
            user = self.require_user()
            with connect() as db:
                rows = db.execute('SELECT * FROM suggestions WHERE user_id=? ORDER BY created DESC', (user['id'],)).fetchall()
            return self.send_json({'suggestions': [{**dict(row), 'payload': json.loads(row['payload'])} for row in rows]})
        if path == '/api/admin':
            self.require_user(admin=True)
            with connect() as db:
                review_rows = db.execute("SELECT r.*,u.name,u.avatar FROM reviews r JOIN users u ON u.id=r.user_id WHERE status!='deleted' ORDER BY created DESC LIMIT 300").fetchall()
                suggestion_rows = db.execute('SELECT s.*,u.name FROM suggestions s JOIN users u ON s.user_id=u.id ORDER BY created DESC LIMIT 300').fetchall()
                events = [json.loads(row[0]) for row in db.execute('SELECT payload FROM events WHERE archived=0')]
            return self.send_json({'reviews': [{**dict(row), 'photos': json.loads(row['photos'])} for row in review_rows],
                                   'suggestions': [{**dict(row), 'payload': json.loads(row['payload'])} for row in suggestion_rows],
                                   'events': events, 'places': get_places()})
        raise ApiError(404, 'API endpoint not found')

    def api_post(self, path, data):
        if path in ('/api/register', '/api/login'):
            limited(('auth', self.client_address[0]))
            email = field(data, 'email', 3, 120).lower()
            password = field(data, 'password', 8, 128)
            if not valid_email(email):
                raise ApiError(400, 'Enter a valid email address')
            limited(('email', email), 12)
            with connect() as db:
                user = db.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
                if path == '/api/register':
                    if user:
                        raise ApiError(409, 'This email is already registered. Please sign in.')
                    uid, salt = secrets.token_hex(16), secrets.token_hex(16)
                    name = field(data, 'name', 2, 40)
                    avatar = image_data(data.get('avatar', ''), 150000)
                    db.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)',
                               (uid, email, name, password_hash(password, salt), salt, avatar, 'user', now_iso()))
                    user = db.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
                else:
                    salt = user['salt'] if user else '00' * 16
                    valid = hmac.compare_digest(password_hash(password, salt), user['password_hash'] if user else '00' * 32)
                    if not user or not valid:
                        raise ApiError(401, 'Incorrect email or password')
            return self.sign_in(user)
        if path == '/api/logout':
            user = self.require_user()
            with connect() as db:
                db.execute('DELETE FROM sessions WHERE token_hash=?', (user['token_hash'],))
            return self.send_json({'ok': True}, cookie=self.cookie('', 0))
        user = self.require_user(admin=path.startswith('/api/admin/'))
        if path == '/api/profile':
            name = field(data, 'name', 2, 40)
            avatar = image_data(data.get('avatar', ''), 150000)
            with connect() as db:
                db.execute('UPDATE users SET name=?,avatar=? WHERE id=?', (name, avatar, user['id']))
                updated = db.execute('SELECT * FROM users WHERE id=?', (user['id'],)).fetchone()
            return self.send_json({'user': public_user(updated)})
        if path == '/api/state':
            allowed_ids = {p['id'] for p in get_places()}
            state = {}
            for key in ('favorites', 'visited'):
                items = data.get(key, [])
                if not isinstance(items, list) or len(items) > 1000 or any(not isinstance(item, str) for item in items):
                    raise ApiError(400, 'Invalid saved places')
                state[key] = list(dict.fromkeys(item for item in items if item in allowed_ids))
            checklist = data.get('checklist', [])
            if not isinstance(checklist, list) or len(checklist) > 50 or any(not isinstance(i, str) or len(i)>80 for i in checklist):
                raise ApiError(400, 'Invalid checklist')
            state['checklist'] = list(dict.fromkeys(checklist))
            state['quizScore'] = integer(data, 'quizScore', 0, 5, 0)
            with connect() as db:
                db.execute('INSERT OR REPLACE INTO user_state VALUES(?,?)', (user['id'], json.dumps(state)))
            return self.send_json({'state': state})
        if path == '/api/reviews':
            limited(('review', user['id']), 10, 3600)
            pid = require_place(data.get('placeId'), site=True)
            rating = integer(data, 'rating', 1, 5)
            text = field(data, 'text', 10, 1500)
            photos = photos_field(data)
            rid = secrets.token_hex(12)
            with connect() as db:
                db.execute('INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?)',
                           (rid, user['id'], pid, rating, text, json.dumps(photos), 'pending', now_iso()))
            return self.send_json({'id': rid, 'status': 'pending'}, 201)
        if path == '/api/reviews/delete':
            rid = field(data, 'id', 1, 50)
            with connect() as db:
                changed = db.execute("UPDATE reviews SET status='deleted' WHERE id=? AND user_id=?", (rid, user['id'])).rowcount
            if not changed:
                raise ApiError(404, 'Review was not found')
            return self.send_json({'ok': True})
        if path == '/api/diary':
            pid = require_place(data.get('placeId'))
            text = field(data, 'text', 1, 3000)
            visited = field(data, 'visited', 10, 10)
            try:
                dt.date.fromisoformat(visited)
            except ValueError:
                raise ApiError(400, 'Invalid visit date')
            photos = photos_field(data)
            eid = field(data, 'id', 0, 50) or secrets.token_hex(12)
            with connect() as db:
                exists = db.execute('SELECT * FROM diary WHERE id=?', (eid,)).fetchone()
                if exists and exists['user_id'] != user['id']:
                    raise ApiError(403, 'This entry belongs to another user')
                db.execute('INSERT INTO diary VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET '
                           'place_id=excluded.place_id,text=excluded.text,photos=excluded.photos,visited=excluded.visited',
                           (eid, user['id'], pid, text, json.dumps(photos), visited, now_iso()))
            return self.send_json({'id': eid}, 201)
        if path == '/api/diary/delete':
            eid = field(data, 'id', 1, 50)
            with connect() as db:
                changed = db.execute('UPDATE diary SET deleted=1 WHERE id=? AND user_id=?', (eid, user['id'])).rowcount
            if not changed:
                raise ApiError(404, 'Entry was not found')
            return self.send_json({'ok': True})
        if path == '/api/suggestions':
            limited(('suggest', user['id']), 5, 3600)
            payload = {key: field(data, key, lo, hi) for key, lo, hi in
                       [('name', 2, 150), ('description', 10, 1500), ('address', 3, 250)]}
            payload['category'] = field(data, 'category', 1, 20)
            if payload['category'] not in CAT_IDS:
                raise ApiError(400, 'Invalid category')
            payload['url'] = safe_url(data.get('url', ''))
            payload['photo'] = image_data(data.get('photo', ''))
            sid = secrets.token_hex(12)
            with connect() as db:
                db.execute('INSERT INTO suggestions VALUES(?,?,?,?,?,NULL)',
                           (sid, user['id'], json.dumps(payload, ensure_ascii=False), 'pending', now_iso()))
            return self.send_json({'id': sid, 'status': 'pending'}, 201)
        if path == '/api/admin/place':
            place = validate_place(data)
            with connect() as db:
                db.execute('INSERT INTO places VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET '
                           'payload=excluded.payload,updated=excluded.updated',
                           (place['id'], json.dumps(place, ensure_ascii=False), now_iso()))
            return self.send_json({'place': place})
        if path == '/api/admin/review':
            rid = field(data, 'id', 1, 50)
            status = field(data, 'status', 1, 20)
            if status not in ('approved', 'rejected', 'pending'):
                raise ApiError(400, 'Invalid moderation status')
            with connect() as db:
                changed = db.execute("UPDATE reviews SET status=? WHERE id=? AND status!='deleted'", (status, rid)).rowcount
            if not changed:
                raise ApiError(404, 'Review was not found')
            return self.send_json({'ok': True})
        if path == '/api/admin/suggestion':
            sid, status = field(data, 'id', 1, 50), field(data, 'status', 1, 20)
            if status not in ('approved', 'rejected'):
                raise ApiError(400, 'Invalid moderation status')
            with connect() as db:
                suggestion = db.execute('SELECT * FROM suggestions WHERE id=?', (sid,)).fetchone()
                if not suggestion:
                    raise ApiError(404, 'Suggestion was not found')
                pid = suggestion['place_id']
                if status == 'approved' and not pid:
                    payload = json.loads(suggestion['payload'])
                    pid = 'community-' + sid
                    place = dict(id=pid, ru=payload['name'], en=payload['name'], descRu=payload['description'],
                                 descEn=payload['description'], cats=[payload['category']], rating=0, price=0,
                                 tags=payload['address'], lat=None, lng=None, image=payload['category'],
                                 photo=payload['photo'], indoor=payload['category'] in ('food','coffee','culture','bar'), minutes=50,
                                 community=True, priceUnknown=True)
                    db.execute('INSERT INTO places VALUES(?,?,?)', (pid, json.dumps(place, ensure_ascii=False), now_iso()))
                db.execute('UPDATE suggestions SET status=?,place_id=? WHERE id=?', (status, pid, sid))
            return self.send_json({'ok': True, 'placeId': pid})
        if path == '/api/admin/event':
            eid = field(data, 'id', 0, 70) or 'manual-' + secrets.token_hex(12)
            if not re.fullmatch(r'[A-Za-z0-9_-]+', eid) or eid.startswith('drama-'):
                raise ApiError(400, 'Invalid event identifier')
            date = field(data, 'date', 16, 40)
            try:
                parsed = dt.datetime.fromisoformat(date)
                if parsed.tzinfo is None:
                    raise ValueError()
            except ValueError:
                raise ApiError(400, 'Event date must include a timezone')
            event = {k: field(data, k, lo, hi) for k, lo, hi in
                     [('title',2,150),('titleEn',2,150),('venue',2,150),('venueEn',2,150),
                      ('description',0,1500),('descriptionEn',0,1500)]}
            price = data.get('price')
            event.update(id=eid, date=parsed.isoformat(), price=None if price in (None, '') else integer(data,'price',0,100000),
                         url=safe_url(data.get('url','')), source=safe_url(data.get('source','')), imported=False)
            with connect() as db:
                db.execute('INSERT INTO events VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,archived=0',
                           (eid, json.dumps(event, ensure_ascii=False)))
            return self.send_json({'event': event})
        if path == '/api/admin/event/archive':
            eid = field(data, 'id', 1, 70)
            with connect() as db:
                db.execute('UPDATE events SET archived=1 WHERE id=?', (eid,))
            return self.send_json({'ok': True})
        raise ApiError(404, 'API endpoint not found')


def create_admin():
    print('Administrator profile: @baerovich. This command runs locally on the server.')
    email = input('Administrator email: ').strip().lower()
    if not valid_email(email):
        raise SystemExit('A valid email is required.')
    password = getpass.getpass('New administrator password (at least 12 characters): ')
    confirm = getpass.getpass('Repeat password: ')
    if password != confirm or len(password) < 12 or len(password) > 128:
        raise SystemExit('Passwords must match and contain 12–128 characters.')
    with connect() as db:
        if db.execute('SELECT 1 FROM users WHERE email=?', (email,)).fetchone():
            raise SystemExit('This email already exists. Choose a separate administrator account.')
        salt = secrets.token_hex(16)
        db.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)',
                   (secrets.token_hex(16), email, '@baerovich', password_hash(password,salt),salt,'','admin',now_iso()))
    print('Administrator created. Sign in on /admin.html with this email and password.')


def main():
    parser = argparse.ArgumentParser(description='Omsk Guide local web server')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--create-admin', action='store_true')
    args = parser.parse_args()
    initialize()
    if args.create_admin:
        create_admin()
        return
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'Omsk Guide: http://{args.host}:{args.port}')
    print('Stop: Ctrl+C. Data is stored privately in SQLite. Admin contact: @baerovich.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
