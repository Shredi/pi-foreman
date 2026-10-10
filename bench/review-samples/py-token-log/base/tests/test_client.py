import unittest

from apiclient.client import Client, HttpError


class FakeTransport:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def __call__(self, url, headers):
        self.calls.append((url, dict(headers)))
        return self.replies.pop(0)


class ClientTest(unittest.TestCase):
    def test_fetch_json_joins_url_and_sends_token(self):
        t = FakeTransport([(200, '{"ok": true}')])
        c = Client("https://api.example.test/", "tok", t)
        self.assertEqual(c.fetch_json("/v1/items"), {"ok": True})
        url, headers = t.calls[0]
        self.assertEqual(url, "https://api.example.test/v1/items")
        self.assertEqual(headers["Authorization"], "Bearer tok")

    def test_error_status_raises(self):
        t = FakeTransport([(404, "missing")])
        with self.assertRaises(HttpError) as cm:
            Client("https://api.example.test", "tok", t).fetch_json("x")
        self.assertEqual(cm.exception.status, 404)


if __name__ == "__main__":
    unittest.main()
