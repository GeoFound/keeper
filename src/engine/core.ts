import type { ModuleRegistration } from './event-bus.ts';
import { EventBus } from './event-bus.ts';

export type StartupTask = () => Promise<void> | void;

export class EngineCore {
  private readonly bus: EventBus;
  private readonly modules = new Map<string, ModuleRegistration & { healthCheck?: () => Promise<unknown> | unknown }>();
  private readonly startupTasks: StartupTask[] = [];
  private running = false;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  register(module: ModuleRegistration & { healthCheck?: () => Promise<unknown> | unknown }): void {
    this.modules.set(module.name, module);
    this.bus.registerModule(module);
  }

  // Startup tasks run ONCE on start(), in registration order, BEFORE the engine begins serving
  // new traffic. Crash recovery (RecoveryCoordinator) registers here so a real boot reconciles the
  // outbox + re-drives interrupted inbound rows automatically (overview inbound_crash_recovery).
  registerStartupTask(task: StartupTask): void {
    this.startupTasks.push(task);
  }

  async start(): Promise<void> {
    for (const task of this.startupTasks) await task();
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async healthCheck(): Promise<Record<string, unknown>> {
    const health: Record<string, unknown> = {};
    for (const module of this.modules.values()) {
      health[module.name] = module.healthCheck ? await module.healthCheck() : { ok: true };
    }
    return health;
  }
}
