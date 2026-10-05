"""Fan-out of one session's events to any number of browser clients.

Every event gets a monotonic cursor. The bus keeps the last ``capacity``
events, so a tab that attaches late, or reconnects after a drop, asks for
everything after the cursor it already saw and misses nothing inside the
window. Subscribers are independent: a slow tab cannot stall the session pump,
it is dropped and replays on reconnect.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from collections.abc import AsyncIterator
from typing import Any

from pydantic import BaseModel, ConfigDict

logger = logging.getLogger(__name__)

DEFAULT_CAPACITY = 1000
DEFAULT_SUBSCRIBER_QUEUE = 500


class GammaEvent(BaseModel):
    """One broadcast event: a cursor, the publish time, and the zeta payload.

    ``at`` is the wall-clock time (epoch seconds) the bus published the event.
    It lets a client measure turn and tool durations that stay correct when
    the event is replayed after a reconnect.
    """

    model_config = ConfigDict(extra="forbid")

    cursor: int
    at: float
    event: str
    payload: dict[str, Any] = {}


class EventBus:
    def __init__(
        self,
        *,
        capacity: int = DEFAULT_CAPACITY,
        subscriber_queue: int = DEFAULT_SUBSCRIBER_QUEUE,
    ) -> None:
        self._buffer: deque[GammaEvent] = deque(maxlen=capacity)
        self._subscriber_queue = subscriber_queue
        self._subscribers: set[asyncio.Queue[GammaEvent | None]] = set()
        self._cursor = 0
        self._closed = False

    @property
    def cursor(self) -> int:
        """The cursor of the newest published event (0 when none)."""

        return self._cursor

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    @property
    def oldest_cursor(self) -> int:
        """Cursor of the oldest replayable event (0 when the buffer is empty)."""

        return self._buffer[0].cursor if self._buffer else 0

    def publish(self, event: str, payload: dict[str, Any] | None = None) -> GammaEvent:
        """Append an event to the buffer and hand it to every subscriber."""

        self._cursor += 1
        record = GammaEvent(cursor=self._cursor, at=time.time(), event=event, payload=payload or {})
        self._buffer.append(record)
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(record)
            except asyncio.QueueFull:
                # Drop the subscriber and end its stream. Its reader closes
                # the socket, and the browser reconnects from its last cursor.
                self._subscribers.discard(queue)
                _drain(queue)
                _put_sentinel(queue)
                logger.warning("dropping a lagging event subscriber at cursor %s", record.cursor)
        return record

    def replay(self, after_cursor: int) -> list[GammaEvent]:
        """Buffered events newer than ``after_cursor``."""

        return [event for event in self._buffer if event.cursor > after_cursor]

    def close(self) -> None:
        """Stop the bus and end every subscriber stream."""

        self._closed = True
        for queue in list(self._subscribers):
            _put_sentinel(queue)
        self._subscribers.clear()

    async def subscribe(self, after_cursor: int = 0) -> AsyncIterator[GammaEvent]:
        """Yield replayed events, then live ones, without gaps or duplicates.

        Registration and the buffer snapshot happen without an await between
        them, so no event can slip between replay and the live stream.
        """

        if self._closed:
            return
        queue: asyncio.Queue[GammaEvent | None] = asyncio.Queue(maxsize=self._subscriber_queue)
        backlog = self.replay(after_cursor)
        self._subscribers.add(queue)
        last = backlog[-1].cursor if backlog else after_cursor
        try:
            for event in backlog:
                yield event
            while True:
                record = await queue.get()
                if record is None:
                    return
                if record.cursor <= last:
                    continue
                last = record.cursor
                yield record
        finally:
            self._subscribers.discard(queue)


def _drain(queue: asyncio.Queue[GammaEvent | None]) -> None:
    while True:
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            return


def _put_sentinel(queue: asyncio.Queue[GammaEvent | None]) -> None:
    try:
        queue.put_nowait(None)
    except asyncio.QueueFull:
        pass


__all__ = ["DEFAULT_CAPACITY", "EventBus", "GammaEvent"]
