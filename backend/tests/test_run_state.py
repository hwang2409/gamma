"""The derived run state follows zeta's run boundaries, not its model turns."""

from __future__ import annotations

from typing import Any

from gamma.session import RunState, next_run_state

CHILD = {"data": {"agent_instance_id": "child-1", "depth": 1}}


def fold(*events: str | tuple[str, dict[str, Any]], start: RunState = "idle") -> RunState:
    state = start
    for item in events:
        name, fields = (item, {}) if isinstance(item, str) else item
        state = next_run_state(state, name, fields)
    return state


def test_a_run_stays_open_between_model_turns() -> None:
    assert fold("agent_start", "turn_start", "turn_end") == "running"
    assert fold("agent_start", "turn_start", "tool_start", "tool_end", "turn_end") == "running"


def test_the_run_ends_at_agent_end() -> None:
    assert fold("agent_start", "turn_start", "turn_end", "turn_start", "turn_end", "agent_end") == (
        "idle"
    )


def test_an_abort_or_an_error_ends_the_run() -> None:
    assert fold("agent_start", "tool_start", "turn_aborted") == "idle"
    assert fold("agent_start", "turn_start", "error") == "idle"


def test_tools_and_approvals_move_the_state_inside_a_run() -> None:
    assert fold("agent_start", "tool_start") == "tool"
    assert fold("agent_start", "approval_request") == "tool"
    assert fold("agent_start", "tool_start", "tool_end") == "running"


def test_tool_events_outside_a_run_leave_it_idle() -> None:
    assert fold("tool_end") == "idle"
    assert fold("tool_start") == "idle"


def test_sub_agent_events_never_move_the_state() -> None:
    # A foreground child runs inside the parent's tool call: its tool_end must
    # not report the parent as back to model streaming.
    assert fold("agent_start", "tool_start", ("tool_end", CHILD)) == "tool"
    assert fold("agent_start", ("approval_request", CHILD)) == "running"
    # A background child does not wake an idle session.
    assert fold(("tool_start", CHILD)) == "idle"
