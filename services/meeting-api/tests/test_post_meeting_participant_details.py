"""Tests for the live participant-profile-image path in post_meeting.

Live flow being exercised:
    bot recording.ts getGoogleParticipantImage
      -> window.__vexaSpeakerEvents (participant_image)
      -> unified-callback -> callbacks.py -> meeting.data["speaker_events"]
      -> post_meeting.aggregate_transcription
      -> meeting.data["participant_details"] = [{name, image}]

Covers `_build_name_to_image_map` in isolation, plus an integration-style
run of `aggregate_transcription` that seeds meeting.data["speaker_events"]
and asserts participant_details is built while participants still works.
"""

from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from meeting_api import post_meeting as post_meeting_module
from meeting_api.post_meeting import _build_name_to_image_map, aggregate_transcription

from .conftest import make_meeting


# ---------------------------------------------------------------------------
# _build_name_to_image_map (pure helper)
# ---------------------------------------------------------------------------

class TestBuildNameToImageMap:
    def test_maps_name_to_image(self):
        events = [
            {"participant_name": "Alice", "participant_image": "https://lh3.googleusercontent.com/a"},
            {"participant_name": "Bob", "participant_image": "https://lh3.googleusercontent.com/b"},
        ]
        assert _build_name_to_image_map(events) == {
            "Alice": "https://lh3.googleusercontent.com/a",
            "Bob": "https://lh3.googleusercontent.com/b",
        }

    def test_skips_events_without_image(self):
        # Older events (pre-feature) have no participant_image key at all.
        events = [
            {"participant_name": "Alice"},
            {"participant_name": "Bob", "participant_image": None},
            {"participant_name": "Carol", "participant_image": "https://img/c"},
        ]
        assert _build_name_to_image_map(events) == {"Carol": "https://img/c"}

    def test_ignores_malformed_entries(self):
        events = [
            None,
            "not-a-dict",
            {"participant_image": "https://img/no-name"},  # missing name
            {"participant_name": "Dave", "participant_image": "https://img/d"},
        ]
        assert _build_name_to_image_map(events) == {"Dave": "https://img/d"}

    def test_empty_and_none(self):
        assert _build_name_to_image_map([]) == {}
        assert _build_name_to_image_map(None) == {}

    def test_last_write_wins_per_name(self):
        events = [
            {"participant_name": "Alice", "participant_image": "https://img/old"},
            {"participant_name": "Alice", "participant_image": "https://img/new"},
        ]
        assert _build_name_to_image_map(events) == {"Alice": "https://img/new"}


# ---------------------------------------------------------------------------
# aggregate_transcription (integration-style, live path)
# ---------------------------------------------------------------------------

def _mock_collector_client(segments):
    """Return a MagicMock that patches httpx.AsyncClient to yield `segments`
    from the collector GET, matching aggregate_transcription's
    `async with httpx.AsyncClient() as client: await client.get(...)`.
    """
    response = MagicMock()
    response.status_code = 200
    response.json = MagicMock(return_value=segments)

    client = MagicMock()
    client.get = AsyncMock(return_value=response)

    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=client)
    ctx.__aexit__ = AsyncMock(return_value=False)
    return MagicMock(return_value=ctx)


@pytest.mark.asyncio
async def test_aggregate_builds_participant_details_from_speaker_events():
    speaker_events = [
        {"event_type": "SPEAKER_START", "participant_name": "Alice",
         "participant_image": "https://lh3.googleusercontent.com/a"},
        {"event_type": "SPEAKER_START", "participant_name": "Bob",
         "participant_image": "https://lh3.googleusercontent.com/b"},
    ]
    meeting = make_meeting(
        start_time=datetime.utcnow(),
        end_time=datetime.utcnow(),
        data={"speaker_events": speaker_events},
    )
    db = MagicMock()
    db.commit = AsyncMock()

    segments = [
        {"speaker": "Alice", "language": "en"},
        {"speaker": "Bob", "language": "en"},
    ]

    with patch.object(post_meeting_module.httpx, "AsyncClient", _mock_collector_client(segments)), \
         patch("sqlalchemy.orm.attributes.flag_modified"):
        result = await aggregate_transcription(meeting, db)

    assert result is True
    # participants (existing behavior) still populated.
    assert meeting.data["participants"] == ["Alice", "Bob"]
    # participant_details (new, additive) carries each name's avatar.
    assert meeting.data["participant_details"] == [
        {"name": "Alice", "image": "https://lh3.googleusercontent.com/a"},
        {"name": "Bob", "image": "https://lh3.googleusercontent.com/b"},
    ]


@pytest.mark.asyncio
async def test_aggregate_participant_details_null_image_when_no_event_match():
    # A speaker present in transcript segments but with no matching
    # speaker_event image → image=None, and the participant is NOT dropped.
    speaker_events = [
        {"event_type": "SPEAKER_START", "participant_name": "Alice",
         "participant_image": "https://img/a"},
    ]
    meeting = make_meeting(
        start_time=datetime.utcnow(),
        end_time=datetime.utcnow(),
        data={"speaker_events": speaker_events},
    )
    db = MagicMock()
    db.commit = AsyncMock()

    segments = [
        {"speaker": "Alice", "language": "en"},
        {"speaker": "Zoe", "language": "en"},  # no avatar known
    ]

    with patch.object(post_meeting_module.httpx, "AsyncClient", _mock_collector_client(segments)), \
         patch("sqlalchemy.orm.attributes.flag_modified"):
        result = await aggregate_transcription(meeting, db)

    assert result is True
    assert meeting.data["participants"] == ["Alice", "Zoe"]
    assert meeting.data["participant_details"] == [
        {"name": "Alice", "image": "https://img/a"},
        {"name": "Zoe", "image": None},
    ]


@pytest.mark.asyncio
async def test_aggregate_participant_details_all_null_when_no_speaker_events():
    # No speaker_events at all (e.g. non-Google platform / older bot) → every
    # participant still listed with image=None; participants unaffected.
    meeting = make_meeting(
        start_time=datetime.utcnow(),
        end_time=datetime.utcnow(),
        data={},
    )
    db = MagicMock()
    db.commit = AsyncMock()

    segments = [{"speaker": "Alice", "language": "en"}]

    with patch.object(post_meeting_module.httpx, "AsyncClient", _mock_collector_client(segments)), \
         patch("sqlalchemy.orm.attributes.flag_modified"):
        result = await aggregate_transcription(meeting, db)

    assert result is True
    assert meeting.data["participants"] == ["Alice"]
    assert meeting.data["participant_details"] == [{"name": "Alice", "image": None}]
