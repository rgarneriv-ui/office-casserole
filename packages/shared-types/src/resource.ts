/**
 * Canonical platform resource envelope — Architecture Specification §13.1.
 * Logical interface shared by every persistent object in the suite; not a
 * requirement that every resource live in one physical store.
 */

export type ResourceId = string;
export type WorkspaceId = string;
export type PrincipalId = string;

export type Classification = "public" | "internal" | "confidential" | "restricted";

export type ProvenanceOrigin = "user" | "import" | "api" | "automation" | "ai";

export interface Provenance {
  origin: ProvenanceOrigin;
  sourceResourceId?: ResourceId;
  sourceRevision?: string;
  actorId: PrincipalId;
  operationId: string;
}

export interface ResourceEnvelope {
  id: ResourceId;
  workspaceId: WorkspaceId;
  resourceType: string;
  schemaVersion: string;

  ownerId: PrincipalId;
  createdAt: string;
  updatedAt: string;
  currentRevision: string;

  classification: Classification;

  storagePolicyId: string;
  encryptionPolicyId: string;
  accessPolicyId: string;
  retentionPolicyId?: string;

  contentHash?: string;
  metadata: Record<string, unknown>;

  provenance: Provenance;
}

/**
 * Agent execution contract — §15.4. All tool calls are separately authorized;
 * retrieved content is untrusted data, never new agent instructions.
 */
export type AgentExecutionMode = "read-only" | "draft-proposals" | "authorized-writes";

export interface AgentExecutionRequest {
  requestId: string;
  principalId: PrincipalId;
  workspaceId: WorkspaceId;

  objective: string;
  allowedResourceIds: ResourceId[];
  allowedTools: string[];

  modelPolicyId: string;
  securityPolicyId: string;
  approvalPolicyId: string;

  budget: {
    maxCostUsd: number;
    maxToolCalls: number;
    maxExecutionSeconds: number;
  };

  executionMode: AgentExecutionMode;
  idempotencyKey: string;
}

export type AgentExecutionStatus = "completed" | "awaiting-approval" | "failed" | "cancelled";

export interface AgentExecutionResult {
  requestId: string;
  status: AgentExecutionStatus;
  producedResourceIds: ResourceId[];
  proposedChanges: unknown[];
  sourceReferences: unknown[];
  validationResults: unknown[];
  auditEventIds: string[];
}

/**
 * Unified command architecture — §18.2. Every interactive command is one
 * canonical definition surfaced through ribbon, palette, API, and agents.
 */
export interface CommandDefinition<Input = unknown> {
  id: string;
  name: string;
  description: string;
  /** Whether the command can run for the current principal/resource. */
  isPermitted: (ctx: unknown) => boolean;
  /** Whether the command applies in the current UI state. */
  isAvailable: (ctx: unknown) => boolean;
  /** Commands that mutate state must be undoable. */
  undoable: boolean;
  shortcut?: string;
  auditClassification: "read" | "document-modification" | "export" | "admin";
  run: (ctx: unknown, input: Input) => void;
}
