import json
import logging

log = logging.getLogger(__name__)


class HttpError(Exception):
    def __init__(self, status, body=""):
        super().__init__("HTTP %d" % status)
        self.status = status
        self.body = body


class Client:
    """Small JSON API client. `transport(url, headers)` returns (status, body text)."""

    def __init__(self, base_url, token, transport):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.transport = transport

    def _headers(self):
        return {"Authorization": "Bearer " + self.token, "Accept": "application/json"}

    def fetch_json(self, path):
        url = self.base_url + "/" + path.lstrip("/")
        status, body = self.transport(url, self._headers())
        if status != 200:
            raise HttpError(status, body)
        return json.loads(body)
