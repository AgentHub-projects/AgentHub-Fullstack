-- CreateTable: DownstreamSession (binding + connection state)
CREATE TABLE "DownstreamSession" (
    "agentHubSessionId"   TEXT      NOT NULL,
    "downstreamSessionId" TEXT      NOT NULL,
    "downstreamAgentId"   TEXT      NOT NULL,
    "state"               TEXT      NOT NULL,
    "lastError"           TEXT,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DownstreamSession_pkey" PRIMARY KEY ("agentHubSessionId")
);

CREATE UNIQUE INDEX "DownstreamSession_agent_session_unique"
    ON "DownstreamSession" ("downstreamAgentId", "downstreamSessionId");

CREATE INDEX "DownstreamSession_downstreamSessionId_idx"
    ON "DownstreamSession" ("downstreamSessionId");

-- CreateTable: DownstreamEventAck (idempotency for session/event acks)
CREATE TABLE "DownstreamEventAck" (
    "eventId"             TEXT      NOT NULL,
    "agentHubSessionId"   TEXT      NOT NULL,
    "downstreamSessionId" TEXT      NOT NULL,
    "runId"               TEXT      NOT NULL,
    "seq"                 INTEGER   NOT NULL,
    "ackedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DownstreamEventAck_pkey" PRIMARY KEY ("eventId")
);

CREATE INDEX "DownstreamEventAck_agentHubSessionId_idx"
    ON "DownstreamEventAck" ("agentHubSessionId");
