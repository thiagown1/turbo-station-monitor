# Station investigator intake

The WhatsApp boundary persists provider timestamps, structured mentions, quotes and forwarding provenance. Only an exact provider mention whose JID is in the central allowlist may create an investigation job. Plain-text lookalikes are ignored.

Jobs are idempotent by source message ID and retain the context fingerprint and message references rather than another full chat copy. The global gate, station-support gate, investigator gate, conversation allowlist and kill switch must pass before analysis. The exact allowed JID found in the provider's structured mention metadata is forwarded to the central API as `mentionedJid`; visible text is never used as authorization.

With `autoSend=false` and the kill switch released, the investigator runs in shadow mode: it calls the central API, stores the bounded result as `review`, and never calls the WhatsApp sender even if an upstream response incorrectly says `decision=send`. With `autoSend=true`, delivery still requires the central API to return both `decision=send` and a non-empty reply. The central API remains responsible for partner/station authorization and technical evidence.

The feature is inert until explicitly configured and activated.
