"""Tests for pipeline.fetch. No test touches the network: urlopen and sleep are fakes."""
import json
import socket
import urllib.error

import pytest

from pipeline.fetch import (
    ConfigError, FetchError, RETRY_DELAYS_S, TIMEOUT_S, build_user_agent, fetch_scout,
)

URL = "https://example.invalid/scout.api"
UA = "FollowUpPriorityBoard/0.1 (+https://example.invalid/repo; me@example.invalid)"
PAYLOAD = {"signature": {"version": "1.3"}, "count": "0"}


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeUrlopen:
    """Plays back a list of outcomes: exceptions are raised, anything else is the body."""

    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.requests = []
        self.timeouts = []

    def __call__(self, request, timeout):
        self.requests.append(request)
        self.timeouts.append(timeout)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return FakeResponse(outcome)


def http_error(code):
    return urllib.error.HTTPError(URL, code, "msg", {}, None)


OK = json.dumps(PAYLOAD).encode()


def fetch(urlopen):
    sleeps = []
    result = fetch_scout(URL, UA, urlopen=urlopen, sleep=sleeps.append)
    return result, sleeps


def fetch_failing(urlopen):
    sleeps = []
    with pytest.raises(FetchError) as info:
        fetch_scout(URL, UA, urlopen=urlopen, sleep=sleeps.append)
    return str(info.value), sleeps


def test_success_makes_exactly_one_request_with_ua_and_timeout():
    urlopen = FakeUrlopen(OK)
    result, sleeps = fetch(urlopen)
    assert result == PAYLOAD
    assert len(urlopen.requests) == 1 and sleeps == []
    assert urlopen.requests[0].get_header("User-agent") == UA
    assert urlopen.timeouts == [TIMEOUT_S] == [30]


def test_retry_delays_are_10_then_30():
    assert RETRY_DELAYS_S == (10, 30)


@pytest.mark.parametrize("code", [500, 503])
def test_retries_once_then_succeeds_after_server_error(code):
    urlopen = FakeUrlopen(http_error(code), OK)
    result, sleeps = fetch(urlopen)
    assert result == PAYLOAD
    assert sleeps == [10] and len(urlopen.requests) == 2


def test_gives_up_after_two_retries():
    urlopen = FakeUrlopen(http_error(503), http_error(500), http_error(503))
    message, sleeps = fetch_failing(urlopen)
    assert sleeps == [10, 30]
    assert len(urlopen.requests) == 3
    assert "3 attempts" in message and "HTTP 503" in message


@pytest.mark.parametrize("error", [
    urllib.error.URLError("dns failed"),
    TimeoutError("timed out"),
    ConnectionResetError("reset"),
    socket.timeout("slow"),
])
def test_network_errors_are_retried(error):
    urlopen = FakeUrlopen(error, OK)
    result, sleeps = fetch(urlopen)
    assert result == PAYLOAD and sleeps == [10]


@pytest.mark.parametrize("code", [400, 403, 404, 429])
def test_other_http_errors_are_final(code):
    urlopen = FakeUrlopen(http_error(code), OK)
    message, sleeps = fetch_failing(urlopen)
    assert f"HTTP {code}" in message
    assert sleeps == [] and len(urlopen.requests) == 1


def test_invalid_json_is_final():
    urlopen = FakeUrlopen(b"<html>maintenance</html>", OK)
    message, sleeps = fetch_failing(urlopen)
    assert "not valid JSON" in message
    assert sleeps == [] and len(urlopen.requests) == 1


# --- User-Agent from config/app.json -------------------------------------------

TEMPLATE = "FollowUpPriorityBoard/0.1 (+{repo_url}; {contact})"


def test_user_agent_is_built_from_config():
    config = {"user_agent_template": TEMPLATE, "repo_url": "https://github.com/x/y", "contact": "a@b.c"}
    assert build_user_agent(config) == "FollowUpPriorityBoard/0.1 (+https://github.com/x/y; a@b.c)"


@pytest.mark.parametrize("repo_url, contact, bad_key", [
    ("<REPO_URL>", "a@b.c", "repo_url"),
    ("", "a@b.c", "repo_url"),
    (None, "a@b.c", "repo_url"),
    ("https://github.com/x/y", "<CONTACT_EMAIL>", "contact"),
    ("https://github.com/x/y", None, "contact"),
])
def test_user_agent_rejects_placeholders_and_blanks(repo_url, contact, bad_key):
    config = {"user_agent_template": TEMPLATE, "repo_url": repo_url, "contact": contact}
    with pytest.raises(ConfigError, match=bad_key):
        build_user_agent(config)
