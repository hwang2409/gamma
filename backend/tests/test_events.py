"""The event bus: cursors, replay from a cursor, and fan-out."""

from __future__ import annotations

import asyncio

from gamma.events import EventBus


def test_cursors_increase_from_one() -> None:
    bus = EventBus(capacity=10)
    first = bus.publish("turn_start", {"turn": 1})
    second = bus.publish("assistant_delta", {"delta": "hi"})
    assert (first.cursor, second.cursor) == (1, 2)
    assert bus.cursor == 2


def test_replay_returns_only_newer_events() -> None:
    bus = EventBus(capacity=10)
    for index in range(5):
        bus.publish("assistant_delta", {"delta": str(index)})
    assert [event.cursor for event in bus.replay(0)] == [1, 2, 3, 4, 5]
    assert [event.cursor for event in bus.replay(3)] == [4, 5]
    assert bus.replay(5) == []


def test_the_buffer_is_bounded() -> None:
    bus = EventBus(capacity=3)
    for index in range(6):
        bus.publish("assistant_delta", {"delta": str(index)})
    assert [event.payload["delta"] for event in bus.replay(0)] == ["3", "4", "5"]
    assert bus.oldest_cursor == 4


async def test_two_subscribers_both_receive_live_events() -> None:
    bus = EventBus(capacity=10)
    received: list[list[int]] = [[], []]

    async def reader(index: int, started: asyncio.Event) -> None:
        async for event in bus.subscribe(after_cursor=0):
            received[index].append(event.cursor)
            started.set()
            if len(received[index]) == 2:
                return

    starts = [asyncio.Event(), asyncio.Event()]
    bus.publish("turn_start", {})
    tasks = [asyncio.create_task(reader(i, starts[i])) for i in (0, 1)]
    await asyncio.gather(*(event.wait() for event in starts))
    bus.publish("turn_end", {})
    await asyncio.wait_for(asyncio.gather(*tasks), timeout=2)

    assert received == [[1, 2], [1, 2]]


async def test_a_reattaching_subscriber_replays_without_duplicates() -> None:
    bus = EventBus(capacity=10)
    bus.publish("turn_start", {})
    bus.publish("assistant_delta", {"delta": "a"})
    bus.publish("assistant_delta", {"delta": "b"})

    seen: list[int] = []

    async def reader() -> None:
        async for event in bus.subscribe(after_cursor=1):
            seen.append(event.cursor)
            if len(seen) == 3:
                return

    task = asyncio.create_task(reader())
    await asyncio.sleep(0)
    bus.publish("turn_end", {})
    await asyncio.wait_for(task, timeout=2)

    assert seen == [2, 3, 4]


async def test_a_live_event_during_replay_is_not_lost_or_duplicated() -> None:
    bus = EventBus(capacity=10)
    bus.publish("a", {})
    bus.publish("b", {})
    stream = bus.subscribe(after_cursor=0)
    first = await anext(stream)
    # The producer runs between two yields of the replay backlog.
    bus.publish("c", {})
    rest = [first.cursor]
    for _ in range(2):
        rest.append((await anext(stream)).cursor)
    await stream.aclose()
    assert rest == [1, 2, 3]


async def test_a_lagging_subscriber_is_dropped_and_its_stream_ends() -> None:
    bus = EventBus(capacity=100, subscriber_queue=2)
    seen: list[int] = []

    async def slow_reader() -> None:
        async for event in bus.subscribe(after_cursor=0):
            seen.append(event.cursor)
            await asyncio.sleep(0.05)

    task = asyncio.create_task(slow_reader())
    await asyncio.sleep(0)
    for _ in range(10):
        bus.publish("assistant_delta", {})

    await asyncio.wait_for(task, timeout=2)
    assert bus.subscriber_count == 0
    assert len(seen) < 10


async def test_close_ends_every_stream() -> None:
    bus = EventBus(capacity=10)
    collected: list[int] = []

    async def reader() -> None:
        async for event in bus.subscribe():
            collected.append(event.cursor)

    task = asyncio.create_task(reader())
    await asyncio.sleep(0)
    bus.publish("turn_start", {})
    await asyncio.sleep(0.01)
    bus.close()
    await asyncio.wait_for(task, timeout=2)
    assert collected == [1]
