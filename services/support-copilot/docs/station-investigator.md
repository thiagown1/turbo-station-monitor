# Station investigator intake

The WhatsApp boundary persists provider timestamps, structured mentions, quotes and forwarding provenance. Only an exact provider mention whose JID is in the central allowlist may create an investigation job. Plain-text lookalikes are ignored.

Jobs are idempotent by source message ID and retain the context fingerprint and message references rather than another full chat copy. The global gate, station-support gate, investigator gate, conversation allowlist, automatic-send gate and kill switch must all pass. The central API remains responsible for partner/station authorization and technical evidence; this service only delivers a final answer when the API returns `decision=send`.

The feature is inert until explicitly configured and activated.
