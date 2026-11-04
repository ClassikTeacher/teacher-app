import type { MiddlewareFn } from 'grammy';
import { AppError } from '@shared/errors/app-error.js';
import { cb, FLOW_NS, parseCb } from './callback.js';
import type { BotContext, FlowState } from './context.js';
import { ack } from './ui.js';

export type FlowNext = { goto: string } | { done: true } | { stay: true };

export interface FlowStep<D> {
  /** Renders the prompt for this step. */
  enter(ctx: BotContext, data: D): Promise<void>;
  onText?(ctx: BotContext, data: D, text: string): Promise<FlowNext>;
  onCallback?(ctx: BotContext, data: D, action: string, args: string[]): Promise<FlowNext>;
  /** A non-text message (file, photo, album item…) while this step is active (M5: uploads and submissions). */
  onMedia?(ctx: BotContext, data: D, message: NonNullable<BotContext['message']>): Promise<FlowNext>;
}

/**
 * A multi-step dialog (T-07). State (`step`, `data`) persists in the session, so flows survive restarts
 * and are driven purely by incoming updates; each step renders itself in `enter`.
 * Button payloads carry the step (`f:<step>:<action>`), so a button left on an old message
 * cannot act on a different step.
 */
export abstract class Flow<D extends Record<string, unknown>> {
  abstract readonly name: string;
  abstract readonly firstStep: string;
  abstract readonly steps: Record<string, FlowStep<D>>;

  /** Builds initial data from the start argument (e.g. invitation token). */
  abstract initial(ctx: BotContext, arg: unknown): Promise<D>;
  /**
   * Runs when the last step returns `done`. Throwing here keeps the flow state so the user can retry;
   * returning `{ goto }` sends the user back to a step with the collected data kept (e.g. a taken name).
   */
  abstract complete(ctx: BotContext, data: D): Promise<void | { goto: string }>;
  /** Runs when the user cancels (/cancel) or the flow is replaced. */
  async cancelled(_ctx: BotContext, _data: D): Promise<void> {}

  async start(ctx: BotContext, arg?: unknown): Promise<void> {
    const data = await this.initial(ctx, arg);
    const state: FlowState = { name: this.name, step: this.firstStep, data, startedAt: Date.now() };
    ctx.session.flow = state;
    await this.stepOf(state.step).enter(ctx, data);
  }

  async handle(ctx: BotContext, state: FlowState): Promise<boolean> {
    const step = this.stepOf(state.step);
    const data = state.data as D;
    let next: FlowNext | undefined;
    const callback = parseCb(ctx.callbackQuery?.data);
    if (callback?.ns === FLOW_NS) {
      const [cbStep, action, ...args] = [callback.action, ...callback.args];
      if (cbStep !== state.step || !action) {
        await ack(ctx, ctx.t('callback-stale'));
        return true;
      }
      await ack(ctx);
      if (step.onCallback) next = await step.onCallback(ctx, data, action, args);
    } else if (ctx.message?.text !== undefined && step.onText) {
      next = await step.onText(ctx, data, ctx.message.text.trim());
    } else if (ctx.message && ctx.message.text === undefined && step.onMedia) {
      next = await step.onMedia(ctx, data, ctx.message);
    } else if (ctx.message && (step.onText || step.onMedia)) {
      // photo, sticker, voice… while a text answer is expected, or text while a file is expected
      await ctx.reply(ctx.t(step.onMedia ? 'flow-media-expected' : 'flow-text-expected'));
      return true;
    }
    if (!next) return false;
    await this.apply(ctx, state, next);
    return true;
  }

  private async apply(ctx: BotContext, state: FlowState, next: FlowNext): Promise<void> {
    if ('stay' in next) return;
    if ('done' in next) {
      const data = state.data as D;
      let back: void | { goto: string };
      try {
        back = await this.complete(ctx, data);
      } catch (error) {
        // Retryable failures keep the state; a conflict or a vanished target cannot succeed on retry.
        if (AppError.is(error, 'CONFLICT') || AppError.is(error, 'NOT_FOUND')) ctx.session.flow = undefined;
        throw error;
      }
      if (back && ctx.session.flow === state) {
        await this.stepOf(back.goto).enter(ctx, data);
        state.step = back.goto;
        return;
      }
      // `complete` may hand over to another dialog (e.g. upload → grant): only this flow's own state is dropped
      if (ctx.session.flow === state) ctx.session.flow = undefined;
      return;
    }
    // The step advances only once its prompt was rendered; a failed `enter` keeps the user on the old step.
    await this.stepOf(next.goto).enter(ctx, state.data as D);
    state.step = next.goto;
  }

  private stepOf(name: string): FlowStep<D> {
    const step = this.steps[name];
    if (!step) throw new Error(`flow ${this.name}: unknown step ${name}`);
    return step;
  }
}

export class FlowRegistry {
  private readonly flows = new Map<string, Flow<Record<string, unknown>>>();

  register<D extends Record<string, unknown>>(flow: Flow<D>): this {
    this.flows.set(flow.name, flow);
    return this;
  }

  get(name: string): Flow<Record<string, unknown>> | undefined {
    return this.flows.get(name);
  }

  /** Dispatches text and `f:` callbacks to the active flow. Install after command handlers. */
  middleware(): MiddlewareFn<BotContext> {
    return async (ctx, next) => {
      const state = ctx.session.flow;
      if (!state) return next();
      const flow = this.flows.get(state.name);
      if (!flow) {
        ctx.session.flow = undefined;
        return next();
      }
      if (ctx.message?.text?.startsWith('/')) return next();
      const handled = await flow.handle(ctx, state);
      if (!handled) return next();
    };
  }

  async cancel(ctx: BotContext): Promise<boolean> {
    const state = ctx.session.flow;
    if (!state) return false;
    ctx.session.flow = undefined;
    await this.flows.get(state.name)?.cancelled(ctx, state.data);
    return true;
  }
}

/** Button payload for a flow step: `f:<step>:<action>[:args]`. */
export const flowCb = (step: string, action: string, ...args: Array<string | number>): string =>
  cb(FLOW_NS, step, action, ...args);
