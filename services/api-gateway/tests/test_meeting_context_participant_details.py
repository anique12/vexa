"""Tests for participant_details enrichment in _get_meeting_context.

The agent-chat meeting-context builder rebuilds `participants` from live
transcript segments and now additionally exposes `participant_details`
([{name, image}]) resolved from the transcript response's speaker_events
(which carry participant_image scraped by the bot). `participants` is left
unchanged for existing consumers.
"""
import json

import httpx
import pytest
from unittest.mock import AsyncMock, MagicMock

import main


def _resp(status_code=200, json_body=None):
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.json = MagicMock(return_value=json_body or {})
    return resp


def _client_with_routes(bots_status, transcript):
    """Mock httpx client whose .get dispatches by URL substring."""
    async def _get(url, **kwargs):
        if "/bots/status" in url:
            return _resp(200, bots_status)
        if "/transcripts/" in url:
            return _resp(200, transcript)
        return _resp(404, {})

    client = MagicMock()
    client.get = AsyncMock(side_effect=_get)
    return client


@pytest.mark.asyncio
async def test_participant_details_built_from_speaker_events():
    bots_status = {
        "running_bots": [
            {"platform": "google_meet", "native_meeting_id": "abc-defg-hij"}
        ]
    }
    transcript = {
        "segments": [
            {"speaker": "Alice", "text": "hi", "absolute_start_time": "t0"},
            {"speaker": "Bob", "text": "yo", "absolute_start_time": "t1"},
        ],
        "speaker_events": [
            {"participant_name": "Alice", "participant_image": "https://lh3.googleusercontent.com/a"},
            {"participant_name": "Bob", "participant_image": "https://lh3.googleusercontent.com/b"},
        ],
    }
    client = _client_with_routes(bots_status, transcript)

    result = await main._get_meeting_context(client, "user-1")
    assert result is not None
    payload = json.loads(result)
    meeting = payload["active_meetings"][0]

    # participants (existing) unchanged — plain list of names.
    assert set(meeting["participants"]) == {"Alice", "Bob"}
    # participant_details (new) — one {name, image} per participant.
    details = {d["name"]: d["image"] for d in meeting["participant_details"]}
    assert details == {
        "Alice": "https://lh3.googleusercontent.com/a",
        "Bob": "https://lh3.googleusercontent.com/b",
    }


@pytest.mark.asyncio
async def test_participant_details_null_image_when_no_speaker_events():
    bots_status = {
        "running_bots": [
            {"platform": "google_meet", "native_meeting_id": "abc-defg-hij"}
        ]
    }
    transcript = {
        "segments": [{"speaker": "Alice", "text": "hi", "absolute_start_time": "t0"}],
        # no speaker_events key at all
    }
    client = _client_with_routes(bots_status, transcript)

    result = await main._get_meeting_context(client, "user-1")
    payload = json.loads(result)
    meeting = payload["active_meetings"][0]

    assert meeting["participants"] == ["Alice"]
    assert meeting["participant_details"] == [{"name": "Alice", "image": None}]
