"""Integration checks against an isolated, temporary SQLite database."""
import datetime as dt
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, build_opener, HTTPCookieProcessor

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server


class Client:
    def __init__(self, base):
        self.base = base
        self.opener = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.csrf = None

    def request(self, path, data=None, headers=None):
        final_headers = {'Accept': 'application/json'}
        if data is not None:
            final_headers.update({'Content-Type': 'application/json', 'X-Requested-With': 'OmskGuide',
                                  'Origin': self.base})
            if self.csrf:
                final_headers['X-CSRF-Token'] = self.csrf
        final_headers.update(headers or {})
        req = Request(self.base + path, data=json.dumps(data).encode() if data is not None else None,
                      headers=final_headers)
        try:
            response = self.opener.open(req, timeout=15)
        except HTTPError as error:
            response = error
        raw = response.read()
        status, response_headers = response.code, response.headers
        response.close()
        try:
            value = json.loads(raw)
        except ValueError:
            value = raw.decode('utf-8', errors='replace')
        if isinstance(value, dict) and value.get('csrf'):
            self.csrf = value['csrf']
        return status, value, response_headers

    def register(self, name='Traveller'):
        self.email = secrets.token_hex(5) + '@example.test'
        self.password = 'Testing-only-2026!'
        code, data, _ = self.request('/api/register', {'name': name, 'email': self.email,
                                                      'password': self.password, 'role': 'admin'})
        assert code == 200, data
        self.user = data['user']
        return data


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.previous_db = server.DB_PATH
        server.DB_PATH = Path(cls.temp.name) / 'test.sqlite3'
        server.initialize()
        class QuietHandler(server.Handler):
            def log_message(self, *args):
                pass
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        cls.base = f'http://127.0.0.1:{cls.http.server_port}'
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        # Admin provisioning is performed through the trusted server-side path, never signup fields.
        salt = secrets.token_hex(16)
        with server.connect() as db:
            db.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)',
                       ('test-admin', 'admin@example.test', '@baerovich',
                        server.password_hash('Admin-testing-2026!', salt), salt, '', 'admin', server.now_iso()))

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        server.DB_PATH = cls.previous_db
        cls.temp.cleanup()

    def setUp(self):
        with server._rate_lock:
            server._rate.clear()
        self.client = Client(self.base)

    def admin(self):
        client = Client(self.base)
        self.assertEqual(client.request('/api/login', {'email': 'admin@example.test',
                                                      'password': 'Admin-testing-2026!'})[0], 200)
        return client

    def test_catalogue_and_real_pages(self):
        code, data, _ = self.client.request('/api/places')
        self.assertEqual(code, 200)
        self.assertGreaterEqual(len(data['places']), 50)
        self.assertEqual(len({p['id'] for p in data['places']}), len(data['places']))
        contents = []
        for name in server.PAGES:
            code, text, headers = self.client.request('/'+name)
            self.assertEqual(code, 200, name)
            self.assertIn('https://t.me/OmskGuide55_Bot', text)
            self.assertIn('https://t.me/baerovich', text)
            self.assertIn("script-src 'self'", headers['Content-Security-Policy'])
            contents.append(text)
        self.assertEqual(len(set(contents)), 9)

    def test_private_source_and_database_are_not_served(self):
        for path in ['/server.py', '/private/omsk.sqlite3', '/data/places.json', '/tests/test_server.py',
                     '/assets/../server.py', '/assets/%2e%2e/server.py', '/assets/%5c..%5cserver.py']:
            self.assertEqual(self.client.request(path)[0], 404, path)

    def test_registration_cannot_grant_admin_or_leak_passwords(self):
        data = self.client.register('@baerovich')
        self.assertEqual(data['user']['role'], 'user')
        self.assertNotIn('password_hash', json.dumps(data))
        self.assertEqual(self.client.request('/api/admin')[0], 403)
        self.assertEqual(self.client.request('/api/admin/place', {})[0], 403)
        with server.connect() as db:
            row = db.execute('SELECT * FROM users WHERE id=?', (data['user']['id'],)).fetchone()
        self.assertNotEqual(row['password_hash'], self.client.password)
        self.assertEqual(len(row['password_hash']), 64)

    def test_cookie_session_csrf_and_origin_guards(self):
        self.client.register()
        code, _, headers = self.client.request('/api/login', {'email': self.client.email,
                                                             'password': self.client.password})
        self.assertEqual(code, 200)
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertIn('SameSite=Strict', headers['Set-Cookie'])
        self.assertEqual(self.client.request('/api/state', {}, {'X-CSRF-Token': 'wrong'})[0], 403)
        self.assertEqual(self.client.request('/api/state', {}, {'Origin': 'https://other.example'})[0], 403)
        self.assertEqual(self.client.request('/api/login', {'email': self.client.email,
                                                           'password': self.client.password},
                                            {'X-Requested-With': 'other'})[0], 403)
        self.assertEqual(Client(self.base).request('/api/reviews', {'placeId': 'site', 'rating': 5,
                                                                  'text': 'Not allowed as a guest.'})[0], 401)

    def test_review_moderation_and_ownership(self):
        self.client.register()
        other = Client(self.base)
        other.register()
        code, created, _ = self.client.request('/api/reviews', {'placeId': 'lyubinsky', 'rating': 5,
                                                              'text': 'A beautiful walk in the city centre.'})
        self.assertEqual(code, 201)
        rid = created['id']
        self.assertEqual(created['status'], 'pending')
        self.assertIn(rid, [r['id'] for r in self.client.request('/api/reviews')[1]['reviews']])
        self.assertNotIn(rid, [r['id'] for r in other.request('/api/reviews')[1]['reviews']])
        self.assertEqual(other.request('/api/reviews/delete', {'id': rid})[0], 404)
        self.assertEqual(self.admin().request('/api/admin/review', {'id': rid, 'status': 'approved'})[0], 200)
        self.assertIn(rid, [r['id'] for r in Client(self.base).request('/api/reviews')[1]['reviews']])
        self.assertEqual(self.client.request('/api/reviews/delete', {'id': rid})[0], 200)
        self.assertNotIn(rid, [r['id'] for r in Client(self.base).request('/api/reviews')[1]['reviews']])

    def test_diary_is_private_and_other_users_cannot_edit_it(self):
        self.client.register()
        other = Client(self.base)
        other.register()
        payload = {'placeId': 'strelka', 'visited': '2026-10-23', 'text': 'Private memories.', 'photos': []}
        code, created, _ = self.client.request('/api/diary', payload)
        self.assertEqual(code, 201)
        eid = created['id']
        self.assertIn(eid, [e['id'] for e in self.client.request('/api/diary')[1]['entries']])
        self.assertEqual(other.request('/api/diary')[1]['entries'], [])
        self.assertEqual(Client(self.base).request('/api/diary')[0], 401)
        self.assertEqual(other.request('/api/diary', {**payload, 'id': eid})[0], 403)
        self.assertEqual(other.request('/api/diary/delete', {'id': eid})[0], 404)
        self.assertEqual(self.client.request('/api/diary/delete', {'id': eid})[0], 200)

    def test_saved_state_syncs_across_sessions(self):
        self.client.register()
        state = {'favorites': ['strelka', 'skuratov', 'missing'], 'visited': ['strelka'],
                 'quizScore': 5, 'checklist': ['water']}
        self.assertEqual(self.client.request('/api/state', state)[0], 200)
        second = Client(self.base)
        self.assertEqual(second.request('/api/login', {'email': self.client.email,
                                                      'password': self.client.password})[0], 200)
        synced = second.request('/api/state')[1]['state']
        self.assertEqual(synced['favorites'], ['strelka', 'skuratov'])
        self.assertEqual(synced['quizScore'], 5)
        self.assertEqual(self.client.request('/api/logout', {})[0], 200)
        self.assertEqual(self.client.request('/api/state')[0], 401)
        self.assertEqual(second.request('/api/state')[0], 200)

    def test_place_suggestion_must_be_approved(self):
        self.client.register()
        name = 'A new community discovery'
        payload = {'name': name, 'address': 'Omsk, central district', 'description': 'An interesting place suggested by a traveller.',
                   'category': 'coffee', 'url': 'https://example.org/place'}
        code, created, _ = self.client.request('/api/suggestions', payload)
        self.assertEqual(code, 201)
        self.assertNotIn(name, [p['ru'] for p in self.client.request('/api/places')[1]['places']])
        admin = self.admin()
        code, result, _ = admin.request('/api/admin/suggestion', {'id': created['id'], 'status': 'approved'})
        self.assertEqual(code, 200)
        places = self.client.request('/api/places')[1]['places']
        self.assertIn(result['placeId'], [p['id'] for p in places])
        # Repeating approval does not create duplicate catalogue entries.
        admin.request('/api/admin/suggestion', {'id': created['id'], 'status': 'approved'})
        self.assertEqual(len([p for p in self.client.request('/api/places')[1]['places'] if p['ru'] == name]), 1)

    def test_admin_catalogue_and_events_roundtrip(self):
        admin = self.admin()
        place = dict(id='test-place',ru='Тестовое место',en='Test place',descRu='Описание места для проверки.',
                     descEn='A place description for verification.',cats=['culture'],rating=4.5,price=500,
                     tags='test',lat=None,lng=None,minutes=60,indoor=True,photo='')
        self.assertEqual(admin.request('/api/admin/place', place)[0], 200)
        self.assertEqual(admin.request('/api/admin/place', {**place, 'photo':'javascript:alert(1)'})[0], 400)
        date = (dt.datetime.now(server.OMSK)+dt.timedelta(days=2)).isoformat(timespec='minutes')
        event = dict(title='Тестовое событие',titleEn='Test event',venue='Музей',venueEn='Museum',
                     date=date,description='',descriptionEn='',url='https://example.org/event',source='',price=300)
        code, result, _ = admin.request('/api/admin/event', event)
        self.assertEqual(code, 200)
        server.put_cache('events', {'events': [], 'updated': server.now_iso()})
        self.assertIn(result['event']['id'], [e['id'] for e in self.client.request('/api/events')[1]['events']])
        self.assertEqual(admin.request('/api/admin/event/archive', {'id': result['event']['id']})[0], 200)
        self.assertNotIn(result['event']['id'], [e['id'] for e in self.client.request('/api/events')[1]['events']])

    def test_images_reject_svg_and_invalid_data(self):
        self.client.register()
        self.assertEqual(self.client.request('/api/profile', {'name':'Traveller','avatar':'data:image/svg+xml;base64,PHN2Zz4='})[0], 400)
        self.assertEqual(self.client.request('/api/profile', {'name':'Traveller','avatar':'data:image/png;base64,YWJjZA=='})[0], 400)

    def test_official_schedule_parser(self):
        source = '''<div data-month="10" data-year="2026"></div><div class="item" data-name="Спектакль"><div class="age"><span>16+</span></div><div class="day">24</div><div class="other-month">октября</div><div class="other-time">19<span>:</span>00</div><a href="/poster/repertoire/test"></a>'''
        events = server.parse_drama(source)
        self.assertEqual(events[0]['date'], '2026-10-24T19:00:00+06:00')
        self.assertEqual(events[0]['source'], server.DRAMA_URL)
        self.assertRaises(ValueError, server.parse_drama, '<html>Markup changed</html>')

    def test_weather_fallback_is_marked_stale(self):
        fixture = {'current': {'temperature_2m': 5, 'apparent_temperature': 3, 'weather_code': 0,
                               'precipitation': 0, 'wind_speed_10m': 12}, 'daily': {}}
        with server.connect() as db:
            db.execute("DELETE FROM cache WHERE name='weather'")
        with patch.object(server, 'fetch_bytes', return_value=json.dumps(fixture).encode()):
            fresh = server.weather()
        self.assertFalse(fresh['stale'])
        with server.connect() as db:
            db.execute("UPDATE cache SET updated=updated-700 WHERE name='weather'")
        with patch.object(server, 'fetch_bytes', side_effect=OSError('offline')):
            fallback = server.weather()
        self.assertTrue(fallback['stale'])
        self.assertEqual(fallback['current']['temperature_2m'], 5)

    def test_login_rate_limit(self):
        for _ in range(12):
            self.assertEqual(self.client.request('/api/login', {'email':'missing@example.test','password':'invalid-password'})[0], 401)
        self.assertEqual(self.client.request('/api/login', {'email':'missing@example.test','password':'invalid-password'})[0], 429)


if __name__ == '__main__':
    unittest.main(verbosity=2)
