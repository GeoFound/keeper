import { z } from 'zod';
import { newId, isoNow } from '../services/ids.ts';

export type EventEnvelope = {
  eventId: string;
  name: string;
  workspaceId: string;
  correlationId: string;
  causationId?: string;
  subjectUserId?: string;
  at: string;
};

export type BusEvent = {
  envelope: EventEnvelope;
  payload: unknown;
  producer: string;
};

export type ModuleRegistration = {
  name: string;
  subscribes: string[];
  publishes: string[];
  handle(event: BusEvent): Promise<void> | void;
};

type ObservabilitySink = {
  recordEvent(name: string, envelope: EventEnvelope, payload: unknown, producer?: string): void;
};

const objectSchema = z.object({}).passthrough();
const idString = z.string().min(1);
const dateLike = z.union([z.date(), z.string().min(1)]);
const senderSchema = z.object({ id: idString, isAdmin: z.boolean().optional() }).passthrough();
const sourceSchema = z.object({ sourceId: idString }).passthrough();
const unifiedMessageSchema = z.object({
  id: idString,
  platform: idString,
  channelId: idString,
  sender: senderSchema,
  content: z.object({
    text: z.string().optional(),
    mediaType: z.enum(['image', 'video', 'file', 'sticker']).optional(),
    mediaUrl: z.string().optional(),
  }).passthrough(),
  timestamp: dateLike,
}).passthrough();
const workspaceSchema = z.object({
  id: idString,
  contentSources: z.array(idString).optional(),
}).passthrough();
const routedMessageSchema = z.object({
  message: unifiedMessageSchema,
  workspace: workspaceSchema,
  allowedSources: z.array(idString),
});
const moderationActionSchema = z.object({
  channelId: idString,
  action: z.enum(['delete', 'mute', 'ban']),
  autonomy: z.enum(['auto', 'proposed', 'approved']),
  reason: idString,
}).passthrough();
const replyDraftSchema = z.object({
  trigger: unifiedMessageSchema,
  intent: z.object({
    category: idString,
    confidence: z.number(),
    mustReply: z.boolean(),
  }).passthrough(),
  retrieval: z.array(objectSchema),
  directives: z.array(z.string()),
}).passthrough();
const outboundMessageSchema = z.object({
  kind: z.enum(['proactive_post', 'welcome', 'activity', 'digest', 'dm', 'notice']),
  audience: z.enum(['community', 'lead', 'owner']),
  content: objectSchema,
  dedupeKey: idString,
  suppressIfKillSwitch: z.boolean(),
}).passthrough();
const replySentSchema = z.object({
  correlationId: idString,
  botMessageId: idString,
  channelId: idString,
  text: z.string(),
  intentCategory: idString,
  hadMarketing: z.boolean(),
  styleVariant: z.enum(['champion', 'challenger']),
  knowledgeSourcesUsed: z.array(idString),
  sentAt: dateLike,
}).passthrough();
const outboundSentSchema = z.object({
  dedupeKey: idString,
  platformMessageId: idString,
  sentAt: dateLike,
}).passthrough();
const scheduledTickSchema = z.object({
  jobId: idString,
  firedAt: dateLike,
  sourceId: idString.optional(),
}).passthrough();
const memberEventSchema = z.object({
  channelId: idString,
  userId: idString,
}).passthrough();
const reactionEventSchema = z.object({
  channelId: idString,
  messageId: idString,
  userId: idString,
  emoji: idString,
}).passthrough();
const approvalDecisionSchema = z.object({
  itemRef: idString,
  type: z.enum([
    'moderation_mute',
    'moderation_ban',
    'black_tier_notify',
    'giveaway',
    'cost_bearing',
    'low_risk_activity',
    'cross_promo',
    'lead_dm',
    'evolution_tuning',
    'onboarding_confirm',
  ]),
  decision: z.enum(['approved', 'rejected', 'amended', 'expired', 'held', 'dropped', 'cancelled']),
  workspaceId: idString,
  decidedAt: dateLike,
}).passthrough();
const ownerActionSchema = z.object({
  senderId: idString,
  kind: z.enum(['decision', 'command', 'text']),
}).passthrough();
const forgetRequestSchema = z.object({
  workspaceId: idString,
  userId: idString,
  scope: z.literal('full'),
});
const leadSchema = z.object({
  workspaceId: idString,
  channelId: idString,
  userId: idString,
  signal: idString,
  evidence: z.array(z.string()),
  proposedDm: z.string(),
}).passthrough();
const activityProposalSchema = z.object({
  proposalId: idString,
  workspaceId: idString,
  channelId: idString,
  type: idString,
  trigger: idString,
  plan: z.string(),
  requiresApproval: z.boolean(),
  dedupeKey: idString,
}).passthrough();

export const EVENT_SCHEMAS = {
  'message.received': unifiedMessageSchema,
  'message.routed': routedMessageSchema,
  'message.clean': routedMessageSchema,
  'moderation.violation': moderationActionSchema,
  'moderation.escalated': moderationActionSchema,
  'inbound.member_joined': memberEventSchema,
  'inbound.member_left': memberEventSchema,
  'inbound.reaction': reactionEventSchema,
  'member.joined': memberEventSchema,
  'member.left': memberEventSchema,
  'reaction.received': reactionEventSchema,
  'control.owner_action': ownerActionSchema,
  'reply.needed': replyDraftSchema,
  'reply.enriched': replyDraftSchema,
  'reply.ready': replyDraftSchema,
  'reply.generated': replyDraftSchema,
  'reply.sent': replySentSchema,
  'outbound.requested': outboundMessageSchema,
  'outbound.sent': outboundSentSchema,
  'atmosphere.cold': z.object({ channelId: idString, state: z.enum(['cold', 'heated', 'idle']), suggestedAction: idString }).passthrough(),
  'activity.proposed': activityProposalSchema,
  'activity.due': scheduledTickSchema,
  'activity.approved': approvalDecisionSchema,
  'activity.rejected': approvalDecisionSchema,
  'cross_promo.proposed': z.object({ proposalId: idString, fromWorkspaceId: idString, toWorkspaceId: idString, product: idString, tone: idString, contextSummary: z.string(), previewText: z.string(), maxPerWeek: z.number(), requiresApproval: z.literal(true) }).passthrough(),
  'cross_promo.approved': approvalDecisionSchema,
  'evolution.tuning_proposed': z.object({ proposalId: idString, workspaceId: idString, dimension: idString, champion: z.string(), challenger: z.string(), rationale: z.string(), sampleCount: z.number(), guardrailReport: objectSchema, redteamPassed: z.boolean() }).passthrough(),
  'evolution.tuning_decided': approvalDecisionSchema,
  'evolution.reflection_due': scheduledTickSchema,
  'evolution.insights_generated': z.object({ workspaceId: idString, generatedAt: dateLike, sampleCount: z.number(), insights: z.array(objectSchema) }).passthrough(),
  'knowledge.sync_due': sourceSchema,
  'knowledge.updated': z.object({ sourceId: idString, added: z.number(), updated: z.number(), removed: z.number() }).passthrough(),
  'digest.due': scheduledTickSchema,
  'retention.sweep_due': scheduledTickSchema,
  'content_calendar.due': scheduledTickSchema,
  'marketing.share_due': scheduledTickSchema,
  'content_gap.detected': z.object({ workspaceId: idString, question: z.string(), topScore: z.number() }).passthrough(),
  'lead.identified': leadSchema,
  'lead.approved': approvalDecisionSchema,
  'lead.rejected': approvalDecisionSchema,
  'lead.followup_due': scheduledTickSchema,
  'user.forget': forgetRequestSchema,
  'onboarding.input': z.object({ phase: z.enum(['start', 'answer', 'confirm', 'cancel']) }).passthrough(),
} satisfies Record<string, z.ZodTypeAny>;

const RAW_SCOPE_DEFERRED_EVENTS = new Set([
  'message.received',
  'inbound.member_joined',
  'inbound.member_left',
  'inbound.reaction',
  'control.owner_action',
]);

const SOURCE_SCOPED_EVENTS = new Set(['knowledge.sync_due', 'knowledge.updated']);
// Whitelisted non-module (infra) producers. `engine` is the restart re-drive: on boot the
// engine re-emits message.routed for crash-interrupted inbound rows (events.yaml
// inbound_crash_recovery / workspace_router restart re-drive), so it produces that event as
// infra, not as the (not-yet-built) Workspace Router module.
const NON_MODULE_PRODUCERS = new Set(['system', 'scheduler', 'runtime', 'platform', 'cli', 'test', 'engine']);

export function isRawScopeDeferredEvent(name: string): boolean {
  return RAW_SCOPE_DEFERRED_EVENTS.has(name);
}

export function isSourceScopedEvent(name: string): boolean {
  return SOURCE_SCOPED_EVENTS.has(name);
}

export function createEnvelope(input: {
  name: string;
  workspaceId: string;
  correlationId: string;
  causationId?: string;
  subjectUserId?: string;
}): EventEnvelope {
  return {
    eventId: newId('evt'),
    name: input.name,
    workspaceId: input.workspaceId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    subjectUserId: input.subjectUserId,
    at: isoNow(),
  };
}

function addSubject(candidates: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) candidates.add(value);
}

function knownSubjects(payload: any): string[] {
  const candidates = new Set<string>();
  addSubject(candidates, payload?.sender?.id);
  addSubject(candidates, payload?.actor?.id);
  addSubject(candidates, payload?.userId);
  addSubject(candidates, payload?.targetUserId);
  addSubject(candidates, payload?.senderId);
  addSubject(candidates, payload?.subjectUserId);
  addSubject(candidates, payload?.message?.sender?.id);
  addSubject(candidates, payload?.trigger?.sender?.id);
  addSubject(candidates, payload?.content?.userId);
  return [...candidates];
}

function validateEnvelope(name: string, envelope: EventEnvelope, payload: unknown): void {
  if (!EVENT_SCHEMAS[name as keyof typeof EVENT_SCHEMAS]) throw new Error(`undeclared event ${name}`);
  if (envelope.name !== name) throw new Error(`envelope name ${envelope.name} does not match ${name}`);
  if (!envelope.correlationId) throw new Error('correlationId is required');

  const hasWorkspace = envelope.workspaceId.length > 0;
  if (isSourceScopedEvent(name) && hasWorkspace) {
    throw new Error(`workspaceId must be empty for source-scoped ${name}`);
  }
  if (!hasWorkspace) {
    if (!isRawScopeDeferredEvent(name) && !isSourceScopedEvent(name)) {
      throw new Error(`workspaceId is required for ${name}`);
    }
    if (isSourceScopedEvent(name) && !(payload as any)?.sourceId) {
      throw new Error(`sourceId is required for ${name}`);
    }
  }

  const subjectCandidates = knownSubjects(payload);
  if (subjectCandidates.length > 0) {
    if (!envelope.subjectUserId) {
      throw new Error(`subjectUserId is required for ${name}`);
    }
    if (!subjectCandidates.includes(envelope.subjectUserId)) {
      throw new Error(`subjectUserId ${envelope.subjectUserId} does not match payload subject for ${name}`);
    }
  }
}

export class EventBus {
  private readonly observability: ObservabilitySink;
  private readonly modules = new Map<string, ModuleRegistration>();

  constructor(input: { observability: ObservabilitySink }) {
    this.observability = input.observability;
  }

  registerModule(module: ModuleRegistration): void {
    for (const event of [...module.subscribes, ...module.publishes]) {
      if (!EVENT_SCHEMAS[event as keyof typeof EVENT_SCHEMAS]) {
        throw new Error(`${module.name} declares unknown event ${event}`);
      }
    }
    this.modules.set(module.name, module);
  }

  async emit(name: keyof typeof EVENT_SCHEMAS | string, envelope: EventEnvelope, payload: unknown, producer: string): Promise<void> {
    const module = this.modules.get(producer);
    if (module && !module.publishes.includes(name)) {
      throw new Error(`${producer} has not declared publish access for ${name}`);
    }
    if (!module && !NON_MODULE_PRODUCERS.has(producer)) {
      throw new Error(`${producer} is not declared as a module or producer`);
    }

    const schema = EVENT_SCHEMAS[name as keyof typeof EVENT_SCHEMAS];
    if (!schema) throw new Error(`event ${name} is not declared`);
    validateEnvelope(name, envelope, payload);
    schema.parse(payload);

    this.observability.recordEvent(name, envelope, payload, producer);
    const event = { envelope, payload, producer };
    for (const subscriber of this.modules.values()) {
      if (subscriber.subscribes.includes(name)) await subscriber.handle(event);
    }
  }
}
