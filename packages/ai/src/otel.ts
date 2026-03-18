/**
 * OpenTelemetry-instrumented StreamFn wrapper for pi-ai.
 *
 * Creates OTel spans for each LLM call following the GenAI semantic conventions.
 * Works with any OTel-compatible exporter (Langfuse, Datadog, Honeycomb, Jaeger, etc.).
 *
 * Prerequisites: configure your OTel NodeSDK with the desired exporter before calling
 * `createOtelStreamFn()`. This module only creates spans — it does not configure the SDK.
 *
 * @example
 * ```typescript
 * import { createOtelStreamFn } from "@mariozechner/pi-ai/otel";
 * import { Agent } from "@mariozechner/pi-agent-core";
 *
 * const otel = await createOtelStreamFn();
 * const agent = new Agent({
 *   streamFn: otel.streamFn,
 *   beforeToolCall: otel.beforeToolCall,
 *   afterToolCall: otel.afterToolCall,
 * });
 *
 * otel.startTrace("user-prompt");
 * await agent.prompt("Hello!");
 * otel.endTrace();
 * ```
 */

import {
	isSpanContextValid,
	type Context as OtelContext,
	context as otelContext,
	type Span,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";
import type { StreamFn } from "./langfuse-types.js";
import { streamSimple } from "./stream.js";
import type { AssistantMessageEvent, Context } from "./types.js";
import { AssistantMessageEventStream } from "./utils/event-stream.js";

export type { StreamFn };

export interface OtelStreamFnOptions {
	/** Inner stream function to wrap. Defaults to streamSimple. */
	innerStreamFn?: StreamFn;
	/** Tracer name. Defaults to "pi-ai". */
	tracerName?: string;
	/** Optional tracer version. */
	tracerVersion?: string;
	/**
	 * W3C traceparent to use as the initial parent context.
	 * When set, all spans will be children of this trace.
	 * Format: "00-<traceId>-<spanId>-<flags>"
	 */
	traceparent?: string;
}

export interface OtelStreamFnResult {
	/** Instrumented stream function to pass to Agent or agent loop. */
	streamFn: StreamFn;
	/**
	 * Start a parent trace span (typed as AGENT in Langfuse).
	 * All subsequent LLM calls and tool executions will be children of this span.
	 * @param name - Trace name (e.g. "explain-repo")
	 * @param input - The human's prompt / input to show on the agent node
	 * @param attributes - Additional span attributes
	 */
	startTrace: (name?: string, input?: unknown, attributes?: Record<string, string>) => void;
	/**
	 * End the current parent trace span.
	 * @param output - The final assistant response to show on the agent node
	 */
	endTrace: (output?: unknown) => void;
	/**
	 * beforeToolCall hook for Agent. Creates an OTel TOOL span.
	 * Wire this to Agent's beforeToolCall option.
	 */
	beforeToolCall: (context: {
		toolCall: { id: string; name: string; arguments: Record<string, unknown> };
	}) => Promise<undefined>;
	/**
	 * afterToolCall hook for Agent. Ends the OTel TOOL span with the result.
	 * Wire this to Agent's afterToolCall option.
	 */
	afterToolCall: (context: {
		toolCall: { id: string; name: string };
		result: { content: Array<{ type: string; text?: string }> };
		isError: boolean;
	}) => Promise<undefined>;
	/**
	 * Get the W3C `traceparent` header for the current trace context.
	 * Pass this to subprocesses via the TRACEPARENT env var to link child traces.
	 * When called with a toolCallId, returns the traceparent specific to that tool call,
	 * which is safe for parallel tool executions.
	 * Returns undefined if no trace is active.
	 */
	getTraceparent: (toolCallId?: string) => string | undefined;
}

interface TraceSpanEntry {
	span: Span;
	context: OtelContext;
	inputCaptured: boolean;
}

/**
 * Convert pi-ai Context to OpenAI-style flat messages array.
 * This produces a format suitable for training data extraction.
 */
function contextToOpenAIMessages(context: Context): unknown[] {
	const messages: unknown[] = [];

	if (context.systemPrompt) {
		messages.push({ role: "system", content: context.systemPrompt });
	}

	for (const msg of context.messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content.map((c) => {
							if (c.type === "text") return { type: "text", text: c.text };
							if (c.type === "image")
								return { type: "image_url", image_url: { url: `data:${c.mimeType};base64,${c.data}` } };
							return c;
						});
			messages.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const textParts = msg.content.filter((c) => c.type === "text");
			const toolCalls = msg.content.filter((c) => c.type === "toolCall");
			const entry: Record<string, unknown> = { role: "assistant" };
			if (textParts.length > 0) {
				entry.content = textParts.map((c) => (c as { text: string }).text).join("");
			} else {
				entry.content = null;
			}
			if (toolCalls.length > 0) {
				entry.tool_calls = toolCalls.map((tc) => {
					const t = tc as { id: string; name: string; arguments: Record<string, unknown> };
					return {
						id: t.id,
						type: "function",
						function: { name: t.name, arguments: JSON.stringify(t.arguments) },
					};
				});
			}
			messages.push(entry);
		} else if (msg.role === "toolResult") {
			const text = msg.content
				.filter((c) => c.type === "text")
				.map((c) => (c as { text: string }).text)
				.join("\n");
			messages.push({
				role: "tool",
				tool_call_id: msg.toolCallId,
				content: text,
			});
		}
	}

	return messages;
}

function messageToAgentInputText(message: Context["messages"][number]): string {
	if (message.role === "user") {
		if (typeof message.content === "string") {
			return `User: ${message.content}`;
		}
		const text = message.content
			.map((content) => {
				if (content.type === "text") return content.text;
				if (content.type === "image") return `[image:${content.mimeType}]`;
				return "";
			})
			.join("\n");
		return `User: ${text}`;
	}

	if (message.role === "assistant") {
		const parts = message.content.map((content) => {
			if (content.type === "text") return content.text;
			if (content.type === "toolCall") return `[tool:${content.name}] ${JSON.stringify(content.arguments)}`;
			return `[${content.type}]`;
		});
		return `Assistant: ${parts.join("\n")}`;
	}

	const toolOutput = message.content
		.map((content) => {
			if (content.type === "text") return content.text;
			if (content.type === "image") return `[image:${content.mimeType}]`;
			return "";
		})
		.join("\n");
	return `Tool ${message.toolName}: ${toolOutput}`;
}

function contextToAgentInput(context: Context, streamOptions?: Parameters<StreamFn>[2]): string {
	const sections: string[] = [];

	if (context.systemPrompt) {
		sections.push(`System prompt:\n${context.systemPrompt}`);
	}

	if (context.messages.length > 0) {
		sections.push(`Conversation:\n${context.messages.map(messageToAgentInputText).join("\n\n")}`);
	}

	if (context.tools && context.tools.length > 0) {
		sections.push(`Tools: ${context.tools.map((tool) => tool.name).join(", ")}`);
	}

	const requestDetails: string[] = [];
	if (streamOptions?.temperature != null) {
		requestDetails.push(`temperature=${streamOptions.temperature}`);
	}
	if (streamOptions?.maxTokens != null) {
		requestDetails.push(`maxTokens=${streamOptions.maxTokens}`);
	}
	if (requestDetails.length > 0) {
		sections.push(`Request: ${requestDetails.join(", ")}`);
	}

	return sections.join("\n\n");
}

function serializeLangfuseValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function setLangfuseInputAttributes(span: Span, input: unknown, isRoot: boolean): void {
	const serializedInput = serializeLangfuseValue(input);
	span.setAttribute("langfuse.observation.input", serializedInput);
	if (isRoot) {
		span.setAttribute("langfuse.trace.input", serializedInput);
	}
}

function setLangfuseOutputAttributes(span: Span, output: unknown, isRoot: boolean): void {
	const serializedOutput = serializeLangfuseValue(output);
	span.setAttribute("langfuse.observation.output", serializedOutput);
	if (isRoot) {
		span.setAttribute("langfuse.trace.output", serializedOutput);
	}
}

function spanToTraceparent(span: Span | null | undefined): string | undefined {
	if (!span) return undefined;
	const spanContext = span.spanContext();
	if (!isSpanContextValid(spanContext)) return undefined;
	const flags = spanContext.traceFlags & 0x01 ? "01" : "00";
	return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

function setProcessTraceparent(traceparent: string | undefined): void {
	if (traceparent) {
		process.env.TRACEPARENT = traceparent;
		return;
	}
	delete process.env.TRACEPARENT;
}

export async function createOtelStreamFn(options?: OtelStreamFnOptions): Promise<OtelStreamFnResult> {
	const tracer = trace.getTracer(options?.tracerName ?? "pi-ai", options?.tracerVersion);
	const innerStreamFn = options?.innerStreamFn ?? streamSimple;

	// Parse TRACEPARENT to establish parent context for linking child process spans
	let rootContext: OtelContext | null = null;
	const traceparent = options?.traceparent ?? process.env.TRACEPARENT;
	const initialTraceparent = traceparent;
	if (traceparent) {
		const parts = traceparent.split("-");
		if (parts.length === 4) {
			const [, traceId, spanId, flagsHex] = parts;
			const traceFlags = parseInt(flagsHex, 16);
			const remoteContext = trace.setSpanContext(otelContext.active(), {
				traceId,
				spanId,
				traceFlags,
				isRemote: true,
			});
			rootContext = remoteContext;
		}
	}

	// Stack of parent trace spans (supports nested startTrace/endTrace for subagents)
	const spanStack: TraceSpanEntry[] = [];

	// Mutable state for tool call spans (keyed by toolCallId)
	const toolSpans = new Map<string, Span>();
	// Per-tool-call traceparent for parallel safety (keyed by toolCallId)
	const toolTraceparents = new Map<string, string>();

	function currentParentEntry(): TraceSpanEntry | null {
		return spanStack.length > 0 ? spanStack[spanStack.length - 1] : null;
	}

	function currentParentSpan(): Span | null {
		return currentParentEntry()?.span ?? null;
	}

	function currentParentContext(): OtelContext | null {
		return currentParentEntry()?.context ?? null;
	}

	const wrappedStreamFn: StreamFn = (model, context, streamOptions) => {
		const parentEntry = currentParentEntry();
		const ctx = parentEntry?.context ?? otelContext.active();
		if (parentEntry && !parentEntry.inputCaptured) {
			setLangfuseInputAttributes(
				parentEntry.span,
				contextToAgentInput(context, streamOptions),
				spanStack.length === 1,
			);
			parentEntry.inputCaptured = true;
		}
		const span = tracer.startSpan(
			"gen_ai.chat",
			{
				attributes: {
					"gen_ai.operation.name": "chat",
					"gen_ai.provider.name": model.provider,
					"gen_ai.request.model": model.id,
					"gen_ai.input.messages": JSON.stringify(contextToOpenAIMessages(context)),
					"langfuse.observation.type": "generation",
					...(streamOptions?.temperature != null && {
						"gen_ai.request.temperature": streamOptions.temperature,
					}),
					...(streamOptions?.maxTokens != null && {
						"gen_ai.request.max_tokens": streamOptions.maxTokens,
					}),
					"gen_ai.request.tool_count": context.tools?.length ?? 0,
					"gen_ai.request.message_count": context.messages.length,
					"gen_ai.request.has_system_prompt": context.systemPrompt != null && context.systemPrompt.length > 0,
					// Langfuse: input as OpenAI-style messages for fallback ingestion paths
					"langfuse.observation.input": JSON.stringify(contextToOpenAIMessages(context)),
				},
			},
			ctx,
		);

		const innerStreamOrPromise = innerStreamFn(model, context, streamOptions);
		const wrappedStream = new AssistantMessageEventStream();

		void pipeWithSpan(innerStreamOrPromise, wrappedStream, span);

		return wrappedStream;
	};

	return {
		streamFn: wrappedStreamFn,

		startTrace: (name?: string, input?: unknown, attributes?: Record<string, string>) => {
			// Start under the current context (could be a tool span for subagents),
			// or rootContext if this is a child process with TRACEPARENT
			const ctx = currentParentContext() ?? rootContext ?? otelContext.active();
			const isRoot = spanStack.length === 0;
			const span = tracer.startSpan(
				name ?? "agent.prompt",
				{
					attributes: {
						...attributes,
						// Only set trace-level attributes on the root span
						...(isRoot && { "langfuse.trace.name": name ?? "agent.prompt" }),
						"langfuse.observation.type": "agent",
					},
				},
				ctx,
			);
			if (input !== undefined) {
				setLangfuseInputAttributes(span, input, isRoot);
			}
			const newCtx = trace.setSpan(ctx, span);
			spanStack.push({ span, context: newCtx, inputCaptured: input !== undefined });
			setProcessTraceparent(spanToTraceparent(span));
		},

		endTrace: (output?: unknown) => {
			const entry = spanStack.pop();
			if (entry) {
				const isRoot = spanStack.length === 0;
				if (output != null) {
					setLangfuseOutputAttributes(entry.span, output, isRoot);
				}
				entry.span.setStatus({ code: SpanStatusCode.OK });
				entry.span.end();
				setProcessTraceparent(spanToTraceparent(currentParentSpan()) ?? initialTraceparent);
			}
		},

		beforeToolCall: async (context) => {
			const ctx = currentParentContext() ?? otelContext.active();
			const span = tracer.startSpan(
				context.toolCall.name,
				{
					attributes: {
						"langfuse.observation.type": "tool",
						"langfuse.observation.input": JSON.stringify(context.toolCall.arguments),
					},
				},
				ctx,
			);
			toolSpans.set(context.toolCall.id, span);

			// Store per-tool-call traceparent for parallel safety.
			// When multiple tools run concurrently, each needs its own traceparent
			// so child processes link to the correct parent span.
			const tp = spanToTraceparent(span);
			if (tp) {
				toolTraceparents.set(context.toolCall.id, tp);
			}

			// Also set global TRACEPARENT for backward compat (sequential tool calls)
			setProcessTraceparent(tp);

			return undefined;
		},

		getTraceparent: (toolCallId?: string) => {
			// If a specific tool call is requested, return its traceparent (parallel-safe)
			if (toolCallId) {
				const tp = toolTraceparents.get(toolCallId);
				if (tp) return tp;
			}
			if (process.env.TRACEPARENT) {
				return process.env.TRACEPARENT;
			}
			return spanToTraceparent(currentParentSpan() ?? trace.getSpan(otelContext.active()));
		},

		afterToolCall: async (context) => {
			const span = toolSpans.get(context.toolCall.id);
			if (span) {
				const outputText = context.result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("\n");
				span.setAttribute("langfuse.observation.output", outputText);
				if (context.isError) {
					span.setStatus({ code: SpanStatusCode.ERROR, message: outputText });
				} else {
					span.setStatus({ code: SpanStatusCode.OK });
				}
				span.end();
				toolSpans.delete(context.toolCall.id);
				toolTraceparents.delete(context.toolCall.id);

				// Restore TRACEPARENT to parent span context (or clear if no parent)
				setProcessTraceparent(spanToTraceparent(currentParentSpan()) ?? initialTraceparent);
			}
			return undefined;
		},
	};
}

async function pipeWithSpan(
	sourceOrPromise: AsyncIterable<AssistantMessageEvent> | Promise<AsyncIterable<AssistantMessageEvent>>,
	target: AssistantMessageEventStream,
	span: Span,
): Promise<void> {
	try {
		const source = await sourceOrPromise;
		for await (const event of source) {
			target.push(event);

			if (event.type === "done") {
				const msg = event.message;
				span.setAttributes({
					"gen_ai.response.model": msg.model,
					"gen_ai.response.finish_reasons": [msg.stopReason],
					"gen_ai.output.messages": JSON.stringify([
						{
							content: msg.content,
							role: "assistant",
						},
					]),
					"gen_ai.usage.input_tokens": msg.usage.input,
					"gen_ai.usage.output_tokens": msg.usage.output,
					"gen_ai.usage.total_tokens": msg.usage.totalTokens,
					"gen_ai.usage.cache_read_tokens": msg.usage.cacheRead,
					"gen_ai.usage.cache_write_tokens": msg.usage.cacheWrite,
					"gen_ai.cost.total": msg.usage.cost.total,
					"gen_ai.cost.input": msg.usage.cost.input,
					"gen_ai.cost.output": msg.usage.cost.output,
					"gen_ai.provider": msg.provider,
					"gen_ai.api": msg.api,
					"langfuse.observation.output": JSON.stringify(msg.content),
				});
				span.setStatus({ code: SpanStatusCode.OK });
				span.end();
			} else if (event.type === "error") {
				const msg = event.error;
				span.setAttributes({
					"gen_ai.response.model": msg.model,
					"gen_ai.response.finish_reasons": [msg.stopReason],
					"gen_ai.output.messages": JSON.stringify([
						{
							content: [{ text: msg.errorMessage ?? "Unknown error", type: "text" }],
							role: "assistant",
						},
					]),
					"gen_ai.usage.input_tokens": msg.usage.input,
					"gen_ai.usage.output_tokens": msg.usage.output,
					"gen_ai.provider": msg.provider,
					"gen_ai.api": msg.api,
					"langfuse.observation.output": JSON.stringify(msg.errorMessage ?? "Unknown error"),
				});
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: msg.errorMessage ?? "Unknown error",
				});
				span.end();
			}
		}
	} catch (err) {
		span.setStatus({
			code: SpanStatusCode.ERROR,
			message: err instanceof Error ? err.message : String(err),
		});
		span.recordException(err instanceof Error ? err : new Error(String(err)));
		span.end();
		target.end();
	}
}
