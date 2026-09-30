# Development guardrails

These limits apply while BaiDee is collecting development data. They are deliberately conservative and can be raised only after real usage and Cloudflare quota review.

## Cloud ingest

- Maximum request body: 8 MB.
- Accepted image types: `image/jpeg` and `image/webp`.
- Maximum daily captures: 500.
- Maximum daily image bytes: 100 MB, measured by the UTC date in the payload.
- When a daily limit is reached, the Worker returns HTTP `429` and does not write to R2.
- Daily counters are stored in D1 table `usage_daily`.
- WebP is preferred for clients that can encode it. The ESP32 camera path currently emits JPEG; the Worker stores WebP with a `.webp` key when supplied.
- R2 lifecycle/retention should delete development objects after 14 days. Configure this in the Cloudflare dashboard or with the account's infrastructure tooling before large collection runs.

## Device behavior

- Default scheduled capture interval: 1 hour.
- Default upload retry interval: 5 minutes.
- Manual Serial `capture` and `upload` remain available for development tests.
- Pending data is limited to the latest capture in LittleFS; this prevents an offline device from filling flash indefinitely.

## Release gate

Before increasing limits or collecting real farm data, measure R2/D1 usage for a full test week, add alerting for 70% and 90% of the chosen limits, and replace the current insecure TLS smoke-test behavior with certificate validation.