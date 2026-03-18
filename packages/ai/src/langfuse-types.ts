/**
 * Shared types for observability modules.
 * Defined here to avoid circular dependency on @mariozechner/pi-agent-core.
 */

import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "./types.js";

export interface StreamFnResult extends AsyncIterable<AssistantMessageEvent> {
	result(): Promise<AssistantMessage>;
}

/** Stream function signature compatible with agent-core StreamFn. */
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => StreamFnResult | Promise<StreamFnResult>;
