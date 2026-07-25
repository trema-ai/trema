import { z } from "zod";
import type {
  ItemDisclosure,
  ItemKind,
  ItemStatus,
  Prisma,
} from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import {
  type ConnectorInstallationBody,
  connectorInstallationBodySchema,
} from "#server/services/connectors/installations.js";

export const memoryTypes = ["fact", "preference", "rule", "procedure"] as const;
export type MemoryType = (typeof memoryTypes)[number];

export const agentWritePolicy = {
  memory: {
    fact: "active",
    preference: "active",
    rule: "proposed",
    procedure: "proposed",
  },
  instruction: { default: "proposed" },
} as const satisfies Record<"memory" | "instruction", Record<string, ItemStatus>>;

export const disclosureDefaults = {
  memory: {
    fact: "retrieved",
    preference: "standing",
    rule: "standing",
    procedure: "retrieved",
  },
  instruction: { default: "standing" },
} as const satisfies Record<"memory" | "instruction", Record<string, ItemDisclosure>>;

export const lifecycleTransitions = {
  activate: { proposed: "active" },
  archive: { proposed: "archived", active: "archived" },
  restore: { archived: "active" },
} as const satisfies Record<string, Partial<Record<ItemStatus, ItemStatus>>>;

export type LifecycleAction = keyof typeof lifecycleTransitions;

export const memoryBodySchema = z
  .object({
    type: z.enum(memoryTypes),
    content: z.string().trim().min(1),
  })
  .strict();

export const instructionBodySchema = z
  .object({
    content: z.string().trim().min(1),
  })
  .strict();

export type MemoryBody = z.infer<typeof memoryBodySchema>;
export type InstructionBody = z.infer<typeof instructionBodySchema>;
export type CreatableItemBody = MemoryBody | InstructionBody | ConnectorInstallationBody;

export class ItemNotFoundError extends Error {
  constructor(message = "Item not found") {
    super(message);
    this.name = "ItemNotFoundError";
  }
}

export class ItemValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItemValidationError";
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function laterPhaseError(kind: ItemKind): ItemValidationError {
  return new ItemValidationError(`Item kind '${kind}' arrives in a later phase`);
}

function activeInstructionError(): ItemValidationError {
  return new ItemValidationError(
    "Scope already has an active instruction; update or archive it instead",
  );
}

// A scope holds at most one active instruction: it is the scope's
// system-prompt addendum, edited in place rather than accumulated. The
// partial unique index Item_one_active_instruction_per_scope backstops
// this check against concurrent writers.
async function assertNoActiveInstruction(
  transaction: Prisma.TransactionClient,
  orgId: string,
  scopeId: string,
): Promise<void> {
  const existing = await transaction.item.findFirst({
    where: { orgId, scopeId, kind: "instruction", status: "active" },
    select: { id: true },
  });
  if (existing) throw activeInstructionError();
}

function connectorRouteError(): ItemValidationError {
  return new ItemValidationError(
    "Connector items must be created or updated through the connector installation routes",
  );
}

function parseBody(kind: ItemKind, body: unknown): CreatableItemBody {
  if (kind === "memory") {
    const parsed = memoryBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ItemValidationError(`Invalid memory body: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  }
  if (kind === "instruction") {
    const parsed = instructionBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ItemValidationError(`Invalid instruction body: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  }
  if (kind === "connector") {
    const parsed = connectorInstallationBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ItemValidationError(`Invalid connector body: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  }
  throw laterPhaseError(kind);
}

function policyKey(kind: "memory" | "instruction", body: CreatableItemBody): string {
  return kind === "memory" ? (body as MemoryBody).type : "default";
}

export function statusForWriter(
  writerKind: "human" | "agent",
  kind: "memory" | "instruction",
  body: CreatableItemBody,
): ItemStatus {
  if (writerKind === "human") return "active";
  const key = policyKey(kind, body);
  return agentWritePolicy[kind][key as keyof (typeof agentWritePolicy)[typeof kind]];
}

export function disclosureForItem(
  kind: "memory" | "instruction",
  body: CreatableItemBody,
): ItemDisclosure {
  const key = policyKey(kind, body);
  return disclosureDefaults[kind][key as keyof (typeof disclosureDefaults)[typeof kind]];
}

function jsonValue(value: CreatableItemBody): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export interface CreateItemInput {
  orgId: string;
  actorPrincipalId: string;
  scopeId: string;
  kind: ItemKind;
  title: string;
  body: unknown;
  status?: ItemStatus;
  disclosure?: ItemDisclosure;
  sourceSessionId?: string;
}

export async function createItem(db: Database, input: CreateItemInput) {
  if (input.kind === "connector") throw connectorRouteError();
  if (input.kind !== "memory" && input.kind !== "instruction") {
    throw laterPhaseError(input.kind);
  }
  const title = input.title.trim();
  if (!title) throw new ItemValidationError("Item title cannot be empty");

  const body = parseBody(input.kind, input.body);
  const [writer, scope] = await Promise.all([
    db.principal.findFirst({
      where: { id: input.actorPrincipalId, orgId: input.orgId },
      select: { id: true, kind: true },
    }),
    db.scope.findFirst({
      where: { id: input.scopeId, orgId: input.orgId },
      select: { id: true },
    }),
  ]);
  if (!writer) throw new ItemValidationError("Writer principal not found");
  if (!scope) throw new ItemValidationError("Item scope not found");

  const status = statusForWriter(writer.kind, input.kind, body);
  const disclosure = input.disclosure ?? disclosureForItem(input.kind, body);

  const item = await db.$transaction(async (transaction) => {
    if (input.kind === "instruction" && status === "active") {
      await assertNoActiveInstruction(transaction, input.orgId, input.scopeId);
    }
    const item = await transaction.item
      .create({
        data: {
          orgId: input.orgId,
          scopeId: input.scopeId,
          kind: input.kind,
          title,
          body: jsonValue(body),
          // Human writers always create active items. Agent requests are
          // deterministically coerced to the write-policy table.
          status,
          disclosure,
          createdById: writer.id,
          updatedById: writer.id,
          ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
        },
      })
      .catch((error: unknown) => {
        if (input.kind === "instruction" && isUniqueViolation(error)) {
          throw activeInstructionError();
        }
        throw error;
      });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: writer.id,
        action: "item.create",
        subject: item.id,
        payload: {
          scopeId: item.scopeId,
          kind: item.kind,
          status: item.status,
          disclosure: item.disclosure,
          requestedStatus: input.status ?? null,
        },
      },
    });
    return item;
  });
  log.info("Item created", { itemId: item.id, kind: item.kind });
  return item;
}

export async function getItem(db: Database, orgId: string, itemId: string) {
  const item = await db.item.findFirst({ where: { id: itemId, orgId } });
  if (!item) throw new ItemNotFoundError();
  return item;
}

export async function listItemVersions(db: Database, orgId: string, itemId: string) {
  const item = await db.item.findFirst({
    where: { id: itemId, orgId },
    select: { id: true },
  });
  if (!item) throw new ItemNotFoundError();

  return db.itemVersion.findMany({
    where: { orgId, itemId: item.id },
    orderBy: { version: "desc" },
    include: { author: { select: { id: true, displayName: true, kind: true } } },
  });
}

export interface ListItemsInput {
  orgId: string;
  kind?: ItemKind;
  status?: ItemStatus;
  scopeId?: string;
}

export async function listItems(db: Database, input: ListItemsInput) {
  return db.item.findMany({
    where: {
      orgId: input.orgId,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export interface UpdateItemInput {
  orgId: string;
  actorPrincipalId: string;
  itemId: string;
  title?: string;
  body?: unknown;
  disclosure?: ItemDisclosure;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function updateItem(db: Database, input: UpdateItemInput) {
  let createdVersionId: string | undefined;
  const item = await db.$transaction(async (transaction) => {
    const existing = await transaction.item.findFirst({
      where: { id: input.itemId, orgId: input.orgId },
    });
    if (!existing) throw new ItemNotFoundError();
    if (existing.kind === "connector") throw connectorRouteError();

    const title = input.title === undefined ? existing.title : input.title.trim();
    if (!title) throw new ItemValidationError("Item title cannot be empty");
    const body = input.body === undefined ? existing.body : parseBody(existing.kind, input.body);
    const contentChanged = title !== existing.title || !jsonEqual(body, existing.body);

    if (contentChanged) {
      const createdVersion = await transaction.itemVersion.create({
        data: {
          orgId: input.orgId,
          itemId: existing.id,
          version: existing.version,
          title: existing.title,
          body: existing.body as Prisma.InputJsonValue,
          // The retained snapshot is attributed to whoever wrote it, not the
          // actor replacing it; items predating updatedById fall back to their creator.
          authorId: existing.updatedById ?? existing.createdById,
        },
      });
      createdVersionId = createdVersion.id;
    }

    const item = await transaction.item.update({
      where: { orgId_id: { orgId: input.orgId, id: existing.id } },
      data: {
        ...(input.title !== undefined ? { title } : {}),
        ...(input.body !== undefined ? { body: body as Prisma.InputJsonValue } : {}),
        ...(input.disclosure !== undefined ? { disclosure: input.disclosure } : {}),
        ...(contentChanged
          ? { version: { increment: 1 }, updatedById: input.actorPrincipalId }
          : {}),
      },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "item.update",
        subject: item.id,
        payload: {
          titleChanged: title !== existing.title,
          bodyChanged: !jsonEqual(body, existing.body),
          disclosure: item.disclosure,
          version: item.version,
        },
      },
    });
    return item;
  });
  if (createdVersionId) {
    log.info("Item version created", {
      itemId: item.id,
      itemVersionId: createdVersionId,
      kind: item.kind,
    });
  }
  return item;
}

export interface TransitionItemInput {
  orgId: string;
  actorPrincipalId: string;
  itemId: string;
  action: LifecycleAction;
}

export async function transitionItem(db: Database, input: TransitionItemInput) {
  const updated = await db.$transaction(async (transaction) => {
    const [item, actor] = await Promise.all([
      transaction.item.findFirst({ where: { id: input.itemId, orgId: input.orgId } }),
      transaction.principal.findFirst({
        where: { id: input.actorPrincipalId, orgId: input.orgId },
        select: { kind: true },
      }),
    ]);
    if (!item) throw new ItemNotFoundError();
    if (actor?.kind !== "human") {
      throw new ItemValidationError("Item lifecycle actions require a human principal");
    }

    const transition = lifecycleTransitions[input.action] as Partial<
      Record<ItemStatus, ItemStatus>
    >;
    const status = transition[item.status];
    if (!status) {
      throw new ItemValidationError(`Cannot ${input.action} an item with status '${item.status}'`);
    }
    if (item.kind === "instruction" && status === "active") {
      await assertNoActiveInstruction(transaction, input.orgId, item.scopeId);
    }

    const updated = await transaction.item
      .update({
        where: { orgId_id: { orgId: input.orgId, id: item.id } },
        data: {
          status,
          ...(input.action === "activate" ? { confirmedById: input.actorPrincipalId } : {}),
        },
      })
      .catch((error: unknown) => {
        if (item.kind === "instruction" && isUniqueViolation(error)) {
          throw activeInstructionError();
        }
        throw error;
      });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: `item.${input.action}`,
        subject: updated.id,
        payload: { previousStatus: item.status, status: updated.status },
      },
    });
    return updated;
  });
  log.info("Item lifecycle changed", {
    itemId: updated.id,
    kind: updated.kind,
    action: input.action,
    status: updated.status,
  });
  return updated;
}

export function activateItem(db: Database, input: Omit<TransitionItemInput, "action">) {
  return transitionItem(db, { ...input, action: "activate" });
}

export function archiveItem(db: Database, input: Omit<TransitionItemInput, "action">) {
  return transitionItem(db, { ...input, action: "archive" });
}

export function restoreItem(db: Database, input: Omit<TransitionItemInput, "action">) {
  return transitionItem(db, { ...input, action: "restore" });
}
