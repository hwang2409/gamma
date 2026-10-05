from gamma.runtime import RuntimeSpec
from gamma.session import GammaSession
from gamma.zeta_protocol import ZetaEvent


def event(name: str, **fields: object) -> ZetaEvent:
    return ZetaEvent.model_validate({"event": name, **fields})


def session() -> GammaSession:
    return GammaSession(
        session_id="gamma-1",
        spec=RuntimeSpec(provider="fake", model="offline"),
        buffer_capacity=20,
    )


def approval(request_id: str, *, delegated: bool = False, agent_id: str | None = None) -> ZetaEvent:
    data = {"agent_instance_id": agent_id} if agent_id is not None else {}
    return event(
        "approval_request",
        request_id=request_id,
        tool_call={"id": "same", "name": "bash", "arguments": {}},
        delegated=delegated,
        data=data,
    )


def test_delegated_approval_end_does_not_clear_foreground_collision() -> None:
    gamma = session()
    gamma.on_zeta_event(approval("foreground"))
    gamma.on_zeta_event(approval("child-request", delegated=True, agent_id="child-1"))

    gamma.on_zeta_event(
        event("approval_end", tool_call={"id": "same"}, data={"agent_instance_id": "child-1"})
    )

    assert set(gamma.pending_approvals) == {"foreground", "child-request"}


def test_foreground_approval_end_still_resolves_foreground() -> None:
    gamma = session()
    gamma.on_zeta_event(approval("foreground"))

    gamma.on_zeta_event(event("approval_end", tool_call={"id": "same"}, data={}))

    assert gamma.pending_approvals == {}


def test_child_end_clears_only_that_child_approval() -> None:
    gamma = session()
    gamma.on_zeta_event(approval("foreground"))
    gamma.on_zeta_event(approval("child-request", delegated=True, agent_id="child-1"))

    gamma.on_zeta_event(event("agent_end", data={"agent_instance_id": "child-1"}))

    assert set(gamma.pending_approvals) == {"foreground"}
