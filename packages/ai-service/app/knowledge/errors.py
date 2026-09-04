"""Shared error type for knowledge extraction pipelines (F3-3).

Extraction failures must be distinguishable from "genuinely no results":
an LLM outage swallowed into an empty list used to overwrite the knowledge
graph with emptiness while the author read "no entities found".
"""


class ExtractionError(RuntimeError):
    """An extraction stage failed (LLM error, unparseable output, wrong shape).

    The HTTP/gRPC layers map this to a `degraded=true` response (or 503)
    instead of a 200-with-empty-results.
    """
