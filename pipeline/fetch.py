"""One polite HTTP GET to Scout.

JPL's fair-use policy asks for a single request per run, an identifying
User-Agent, and no hammering. Retries (max 2) only happen after a network
error or HTTP 500/503; any other failure is final.
"""
import http.client
import json
import logging
import time
import urllib.error
import urllib.request

log = logging.getLogger(__name__)

TIMEOUT_S = 30
RETRY_DELAYS_S = (10, 30)  # one retry after 10 s, a second after 30 s
RETRYABLE_STATUS = (500, 503)  # database unavailable / overloaded


class ConfigError(Exception):
    """config/app.json can't be used. Raised before any file is touched."""


class FetchError(Exception):
    """Scout couldn't be read. The caller records the failure and keeps old data."""


def build_user_agent(config):
    values = {"repo_url": config.get("repo_url"), "contact": config.get("contact")}
    for key, value in values.items():
        # A "<...>" value is a placeholder that was never filled in.
        if not value or "<" in value:
            raise ConfigError(f"config/app.json: {key} is not set (got {value!r})")
    return config["user_agent_template"].format(**values)


def fetch_scout(url, user_agent, urlopen=urllib.request.urlopen, sleep=time.sleep):
    """GET url and return the decoded JSON. urlopen and sleep are injectable for tests."""
    request = urllib.request.Request(
        url, headers={"User-Agent": user_agent, "Accept": "application/json"}
    )
    attempts = len(RETRY_DELAYS_S) + 1
    problem = None
    for attempt in range(attempts):
        if attempt:
            delay = RETRY_DELAYS_S[attempt - 1]
            log.warning("Retrying in %d s after: %s", delay, problem)
            sleep(delay)
        try:
            with urlopen(request, timeout=TIMEOUT_S) as response:
                body = response.read()
        except urllib.error.HTTPError as e:  # must come first: HTTPError is also an OSError
            if e.code not in RETRYABLE_STATUS:
                raise FetchError(f"Scout returned HTTP {e.code}") from e
            problem = f"HTTP {e.code}"
        except (OSError, http.client.HTTPException) as e:  # DNS, refused, timeout, cut-off reply
            problem = f"{type(e).__name__}: {e}"
        else:
            try:
                return json.loads(body)
            except ValueError as e:  # a garbled body won't fix itself on retry
                raise FetchError("Scout's response is not valid JSON") from e
    raise FetchError(f"Gave up after {attempts} attempts: {problem}")
