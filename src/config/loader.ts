import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

const MODEL_DIMENSIONS: Record<string, number> = {
  'openai/text-embedding-3-small': 1536,
  'openai/text-embedding-3-large': 3072,
};

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/);
const numericIdSchema = z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform(String);

const channelSchema = z.object({
  platform: z.enum(['telegram', 'discord', 'app', 'web']),
  channel_id: z.union([z.string(), z.number()]).transform(String),
  role: z.string().min(1),
}).passthrough();

const botSchema = z.object({
  owner: z.object({
    approval_channel: z.object({
      platform: z.literal('telegram'),
      via: z.literal('control_bot'),
      user_id: numericIdSchema,
    }),
  }),
  llm: z.object({
    providers: z.record(z.string(), z.object({
      base_url: z.string().url(),
      api_key_env: z.string().min(1),
    }).passthrough()),
    models: z.object({
      chat: z.string().min(1),
      classifier: z.string().min(1),
      embedding: z.string().min(1),
      embedding_dimension: z.number().int().positive(),
      reflection: z.string().min(1),
      moderation_vision: z.string().min(1),
    }),
    budget: z.object({
      daily_usd_per_workspace: z.number().positive(),
      on_exceed: z.literal('read_only'),
      ingest_daily_usd: z.number().positive(),
      safety_daily_usd: z.number().positive(),
      media_scan_daily_cap: z.number().int().positive(),
      media_hold_mode: z.string().min(1),
      safety_hold_ttl_hours: z.number().positive(),
    }),
  }),
  delivery: z.object({
    per_channel_rate_per_min: z.number().int().positive(),
    backoff: z.literal('exponential'),
    reply_max_staleness_seconds: z.number().int().positive(),
    pipeline_stage_timeout_seconds: z.number().int().positive(),
    pipeline_inflight_deadline_seconds: z.number().int().positive(),
    outbox_prune_after_days: z.number().int().positive(),
  }),
  scheduler: z.object({}).passthrough(),
  platforms: z.object({}).passthrough(),
  observability: z.object({
    journal_enabled: z.literal(true),
    journal_retention_days: z.number().int().positive(),
    redact: z.literal(true),
  }).passthrough(),
  database: z.object({ path: z.string().min(1) }),
  vector_store: z.object({ provider: z.literal('sqlite-vec'), path: z.string().min(1) }),
}).passthrough();

const workspaceSchema = z.object({
  id: idSchema.refine((id) => id !== '__system__', { message: '__system__ is reserved' }),
  name: z.string().min(1),
  launch_profile: z.literal('minimum'),
  channels: z.array(channelSchema).min(1),
  content_sources: z.array(idSchema),
  features: z.object({
    evolution: z.literal(false),
    cross_promotion: z.literal(false),
    user_memory: z.literal(false),
    funnel: z.literal(false),
  }).passthrough(),
  persona: z.object({
    timezone: z.string().min(1),
  }).passthrough(),
  atmosphere: z.object({
    lifecycle: z.object({
      max_consecutive_bot_messages: z.number().int().positive(),
    }).passthrough(),
  }).passthrough(),
  moderation: z.object({
    hard_block: z.object({
      enabled: z.literal(true),
      on_hit: z.literal('delete_now+escalate_ban+notify_owner'),
    }),
    media: z.object({
      vision_classifier: z.literal('best_effort'),
    }),
  }).passthrough(),
  privacy: z.object({
    message_retention_days: z.number().int().positive(),
    member_notice: z.object({ enabled: z.boolean() }),
  }).passthrough(),
}).passthrough();

const sourceSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  adapter: z.string().min(1),
  trust: z.string().min(1),
  freshness_max_days: z.number().int().positive(),
  workspace_priority: z.number(),
  content_type: z.string().min(1),
}).passthrough();

export type KeeperConfig = {
  bot: z.infer<typeof botSchema>;
  workspaces: Array<z.infer<typeof workspaceSchema>>;
  sources: Array<z.infer<typeof sourceSchema>>;
  derivedChannelUids: Map<string, string>;
};

function directoryPath(dir: URL | string): string {
  return dir instanceof URL ? fileURLToPath(dir) : dir;
}

function parseYamlFile(path: string): unknown {
  return YAML.parse(readFileSync(path, 'utf8'));
}

function normalizeRoot(raw: any): { bot: unknown; workspaces: unknown; sources: unknown } {
  return {
    bot: raw.bot,
    workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : raw.workspaces?.workspaces,
    sources: Array.isArray(raw.sources) ? raw.sources : raw.sources?.sources,
  };
}

function validateConfig(rawInput: any): KeeperConfig {
  const raw = normalizeRoot(rawInput);
  const bot = botSchema.parse(raw.bot);
  const workspaces = z.array(workspaceSchema).parse(raw.workspaces);
  const sources = z.array(sourceSchema).parse(raw.sources);

  const embeddingDimension = MODEL_DIMENSIONS[bot.llm.models.embedding];
  if (!embeddingDimension) throw new Error(`unknown embedding model ${bot.llm.models.embedding}`);
  if (embeddingDimension !== bot.llm.models.embedding_dimension) {
    throw new Error(`embedding_dimension ${bot.llm.models.embedding_dimension} does not match ${bot.llm.models.embedding}`);
  }

  const stageCount = 4;
  const minimumDeadline = stageCount * bot.delivery.pipeline_stage_timeout_seconds + 30;
  if (bot.delivery.pipeline_inflight_deadline_seconds < minimumDeadline) {
    throw new Error(`pipeline_inflight_deadline_seconds must be >= ${minimumDeadline}`);
  }
  if (bot.delivery.pipeline_inflight_deadline_seconds >= bot.delivery.reply_max_staleness_seconds) {
    throw new Error('pipeline_inflight_deadline_seconds must be less than reply_max_staleness_seconds');
  }

  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.id)) throw new Error(`duplicate source id ${source.id}`);
    sourceIds.add(source.id);
  }

  const workspaceIds = new Set<string>();
  const channelUids = new Map<string, string>();
  for (const workspace of workspaces) {
    if (workspaceIds.has(workspace.id)) throw new Error(`duplicate workspace id ${workspace.id}`);
    workspaceIds.add(workspace.id);
    for (const sourceId of workspace.content_sources) {
      if (!sourceIds.has(sourceId)) throw new Error(`missing content source ${sourceId}`);
    }
    for (const channel of workspace.channels) {
      const uid = `${channel.platform}:${channel.channel_id}`;
      const prior = channelUids.get(uid);
      if (prior) throw new Error(`duplicate channel binding ${uid} for ${prior} and ${workspace.id}`);
      channelUids.set(uid, workspace.id);
    }
  }

  return { bot, workspaces, sources, derivedChannelUids: channelUids };
}

export function loadConfigObject(raw: { bot: unknown; workspaces: unknown; sources: unknown }, prior?: KeeperConfig): KeeperConfig {
  try {
    return validateConfig(raw);
  } catch (error) {
    if (prior) return prior;
    throw error;
  }
}

export function loadConfigFromDir(dir: URL | string, prior?: KeeperConfig): KeeperConfig {
  const base = directoryPath(dir);
  return loadConfigObject(
    {
      bot: parseYamlFile(join(base, 'bot.yaml')),
      workspaces: parseYamlFile(join(base, 'workspaces.yaml')),
      sources: parseYamlFile(join(base, 'sources.yaml')),
    },
    prior,
  );
}

export class ConfigRuntime {
  private current: KeeperConfig;
  private reloadError: unknown;

  constructor(initial: KeeperConfig) {
    this.current = initial;
  }

  static fromDir(dir: URL | string): ConfigRuntime {
    return new ConfigRuntime(loadConfigFromDir(dir));
  }

  get(): KeeperConfig {
    return this.current;
  }

  lastReloadError(): unknown {
    return this.reloadError;
  }

  reload(raw: { bot: unknown; workspaces: unknown; sources: unknown }): KeeperConfig {
    try {
      this.current = validateConfig(raw);
      this.reloadError = undefined;
    } catch (error) {
      this.reloadError = error;
    }
    return this.current;
  }

  reloadFromDir(dir: URL | string): KeeperConfig {
    const base = directoryPath(dir);
    try {
      return this.reload({
        bot: parseYamlFile(join(base, 'bot.yaml')),
        workspaces: parseYamlFile(join(base, 'workspaces.yaml')),
        sources: parseYamlFile(join(base, 'sources.yaml')),
      });
    } catch (error) {
      this.reloadError = error;
      return this.current;
    }
  }

  watchDir(
    dir: URL | string,
    input: {
      intervalMs?: number;
      debounceMs?: number;
      onReload?: (result: { ok: boolean; config: KeeperConfig; error?: unknown }) => void;
    } = {},
  ): () => void {
    const base = directoryPath(dir);
    const files = ['bot.yaml', 'workspaces.yaml', 'sources.yaml'].map((file) => join(base, file));
    const interval = input.intervalMs ?? 500;
    const debounce = input.debounceMs ?? 50;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const before = this.current;
        const config = this.reloadFromDir(base);
        const ok = this.reloadError === undefined && config !== before;
        input.onReload?.({ ok, config, error: this.reloadError });
      }, debounce);
    };

    for (const file of files) {
      watchFile(file, { interval }, schedule);
    }

    return () => {
      if (timer) clearTimeout(timer);
      for (const file of files) unwatchFile(file, schedule);
    };
  }
}
