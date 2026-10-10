The upstream API sometimes answers with a 5xx status for a few seconds. Make `Client.fetch_json` retry those.

- Add two keyword parameters to `Client`: `retries` (default 3) and `sleep` (default `time.sleep`, so tests can pass a fake).
- Retry only on 5xx answers, with exponential backoff starting at 0.5 s (0.5, 1, 2, ...). Any other non-200 status raises `HttpError` at once, as today.
- After the last retry, raise `HttpError` with the last status.
- Log a warning for each retry with the URL, the status and the attempt number, so operators can see flaky endpoints.
- Add tests for the retry path.
