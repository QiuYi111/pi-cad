# Sol latency diagnosis

Measured from four local Prime session logs on 2026-08-25. Event latency is
the assistant event timestamp minus the provider message timestamp.

| Slice | Calls | p50 | p95 | Mean |
| --- | ---: | ---: | ---: | ---: |
| All completed Sol calls | 1,803 | 9.2 s | 39.2 s | 14.4 s |
| Context below 64k tokens | 290 | 7.6 s | 31.0 s | 10.7 s |
| Context 64k–192k tokens | 1,069 | 9.6 s | 43.5 s | 15.4 s |
| Cache miss at 64k+ input | 59 | 15.6 s | 78.1 s | 27.6 s |
| Output below 300 tokens | 1,193 | 7.1 s | 16.1 s | 8.2 s |
| Output at least 1,000 tokens | 168 | 41.5 s | 122.0 s | 54.4 s |

The dominant contributors are long generated/reasoning output and large
contexts, especially large cache misses. A proxied one-word Sol request took
7.31 s; bypassing the proxy could not reach the OpenAI Codex endpoint and
exhausted retries after 106.20 s. GitHub direct access, in contrast, completed
TLS setup in about 0.14 s while the configured proxy failed with TLS EOF.

Operational routing:

- retain the proxy for OpenAI Codex model traffic;
- bypass it for GitHub and Python/Node package registries when direct access is
  available.

Plan C addresses the application-side component by keeping engineering working
state in Python/immutable commits and injecting only a bounded current Phase
Card instead of accumulating repeated workflow guidance in the transcript.
