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
    fields: dict[str, object] = {
        "request_id": request_id,
        "tool_call": {"id": "same", "name": "bash", "arguments": {}},
        "delegated": delegated,
    }
    if agent_id is not None:
        fields["agent_instance_id"] = agent_id
    return event("approval_request", **fields)


def test_approval_end_uses_request_id_for_colliding_calls() -> None:
    gamma = session()
    gamma.on_zeta_event(approval("foreground"))
    gamma.on_zeta_event(approval("child-request", delegated=True, agent_id="child-1"))

    gamma.on_zeta_event(
        event("approval_end", request_id="child-request", tool_call={"id": "same"}, data={})
    )
    assert set(gamma.pending_approvals) == {"foreground"}

    gamma.on_zeta_event(
        event("approval_end", request_id="foreground", tool_call={"id": "same"}, data={})
    )
    assert gamma.pending_approvals == {}


def test_child_cancel_approval_end_closes_delegated_approval() -> None:
    gamma = session()
    gamma.on_zeta_event(approval("child-request", delegated=True, agent_id="child-1"))
    gamma.on_zeta_event(
        event("approval_end", request_id="child-request", tool_call={"id": "same"}, data={})
    )
    gamma.on_zeta_event(event("turn_aborted", data={"agent_instance_id": "child-1"}))
    assert gamma.pending_approvals == {}


async def test_status_reconciles_pending_approvals() -> None:
    class Connection:
        alive = True

        async def call(self, method: str, params: dict[str, object]) -> dict[str, object]:
            assert method == "status"
            return {
                "state": "tool",
                "pending_approvals": [
                    {
                        "request_id": "new",
                        "tool_call": {"id": "same", "name": "bash", "arguments": {}},
                        "delegated": True,
                        "agent_instance_id": "child-1",
                    }
                ],
            }

    gamma = session()
    gamma.on_zeta_event(approval("old"))
    gamma._connection = Connection()  # type: ignore[assignment]
    await gamma.status()
    assert set(gamma.pending_approvals) == {"new"}
    assert gamma.pending_approvals["new"].agent_instance_id == "child-1"
