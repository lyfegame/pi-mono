/**
 * Langfuse observability for pi-ai.
 *
 * Sets up OpenTelemetry export via Langfuse and uses Langfuse's tracing helpers
 * so agent, tool, and generation observations show structured input/output in the UI.
 */

import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
	type LangfuseAgent,
	type LangfuseGeneration,
	type LangfuseTool,
	setLangfuseTracerProvider,
	startObservation,
} from "@langfuse/tracing";
import { isSpanContextValid, context as otelContext, type SpanContext, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { StreamFn } from "./langfuse-types.js";
import { streamSimple } from "./stream.js";
import type { AssistantMessage, AssistantMessageEvent, Context, ToolResultMessage, UserMessage } from "./types.js";
import { AssistantMessageEventStream } from "./utils/event-stream.js";

export interface LangfuseStreamFnOptions {
	/** Langfuse public key. Falls back to LANGFUSE_PUBLIC_KEY env var. */
	publicKey?: string;
	/** Langfuse secret key. Falls back to LANGFUSE_SECRET_KEY env var. */
	secretKey?: string;
	/** Langfuse base URL. Falls back to LANGFUSE_BASE_URL env var. */
	baseUrl?: string;
	/** Inner stream function to wrap. Defaults to streamSimple. */
	innerStreamFn?: StreamFn;
	/** W3C traceparent to use as the initial parent context. */
	traceparent?: string;
}

export interface LangfuseStreamFnResult {
	/** Instrumented stream function to pass to Agent or agent loop. */
	streamFn: StreamFn;
	/** Start a parent trace (typed as AGENT in Langfuse). */
	startTrace: (name?: string, input?: unknown, attributes?: Record<string, unknown>, sessionId?: string) => void;
	/** End the current parent trace span. */
	endTrace: (output?: unknown) => void;
	/** beforeToolCall hook — creates TOOL spans. Wire to Agent's beforeToolCall. */
	beforeToolCall: (context: {
		toolCall: { id: string; name: string; arguments: Record<string, unknown> };
	}) => Promise<undefined>;
	/** afterToolCall hook — ends TOOL spans with result. Wire to Agent's afterToolCall. */
	afterToolCall: (context: {
		toolCall: { id: string; name: string };
		result: { content: Array<{ type: string; text?: string }> };
		isError: boolean;
	}) => Promise<undefined>;
	/** Get W3C traceparent for the current trace. Pass toolCallId for parallel-safe lookups. */
	getTraceparent: (toolCallId?: string) => string | undefined;
	/** Flush pending spans and shut down the OTel SDK. Call on process exit. */
	shutdown: () => Promise<void>;
}

interface AgentTraceEntry {
	observation: LangfuseAgent;
	inputCaptured: boolean;
}

interface ObservabilityUserMessage {
	role: "user";
	content: UserMessage["content"];
}

interface ObservabilityAssistantMessage {
	role: "assistant";
	content: AssistantMessage["content"];
}

interface ObservabilityToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: ToolResultMessage["content"];
	isError: boolean;
}

type ObservabilityMessage = ObservabilityUserMessage | ObservabilityAssistantMessage | ObservabilityToolResultMessage;

function sanitizeUserContent(content: UserMessage["content"]): UserMessage["content"] {
	if (typeof content === "string") {
		return content;
	}

	return content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: block.text,
			};
		}

		return {
			type: "image" as const,
			data: block.data,
			mimeType: block.mimeType,
		};
	});
}

function sanitizeAssistantContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
	return content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: block.text,
			};
		}

		if (block.type === "thinking") {
			return {
				type: "thinking" as const,
				thinking: block.thinking,
				...(block.redacted ? { redacted: true } : {}),
			};
		}

		return {
			type: "toolCall" as const,
			id: block.id,
			name: block.name,
			arguments: block.arguments,
		};
	});
}

function sanitizeToolResultContent(content: ToolResultMessage["content"]): ToolResultMessage["content"] {
	return content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: block.text,
			};
		}

		return {
			type: "image" as const,
			data: block.data,
			mimeType: block.mimeType,
		};
	});
}

function contextToObservabilityMessages(context: Context): ObservabilityMessage[] {
	const messages: ObservabilityMessage[] = [];

	for (const message of context.messages) {
		if (message.role === "user") {
			messages.push({ role: "user", content: sanitizeUserContent(message.content) });
			continue;
		}

		if (message.role === "assistant") {
			messages.push({ role: "assistant", content: sanitizeAssistantContent(message.content) });
			continue;
		}

		messages.push({
			role: "toolResult",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: sanitizeToolResultContent(message.content),
			isError: message.isError,
		});
	}

	return messages;
}

function contextToConversationInput(
	context: Context,
	streamOptions?: Parameters<StreamFn>[2],
): Record<string, unknown> {
	const input: Record<string, unknown> = {
		messages: contextToObservabilityMessages(context),
	};

	if (context.systemPrompt) {
		input.systemPrompt = context.systemPrompt;
	}

	if (context.tools && context.tools.length > 0) {
		input.tools = context.tools;
	}

	const request: Record<string, number> = {};
	if (streamOptions?.temperature != null) {
		request.temperature = streamOptions.temperature;
	}
	if (streamOptions?.maxTokens != null) {
		request.maxTokens = streamOptions.maxTokens;
	}
	if (Object.keys(request).length > 0) {
		input.request = request;
	}

	return input;
}

function contextToAgentInput(
	model: Parameters<StreamFn>[0],
	context: Context,
	streamOptions?: Parameters<StreamFn>[2],
): Record<string, unknown> {
	return {
		model: {
			api: model.api,
			id: model.id,
			name: model.name,
			provider: model.provider,
		},
		...contextToConversationInput(context, streamOptions),
	};
}

function parseTraceparent(traceparent: string | undefined): SpanContext | undefined {
	if (!traceparent) return undefined;
	const parts = traceparent.split("-");
	if (parts.length !== 4) return undefined;
	const [, traceId, spanId, flagsHex] = parts;
	const traceFlags = Number.parseInt(flagsHex, 16);
	if (Number.isNaN(traceFlags)) return undefined;
	return {
		traceId,
		spanId,
		traceFlags,
		isRemote: true,
	};
}

function spanContextToTraceparent(spanContext: SpanContext | undefined): string | undefined {
	if (!spanContext || !isSpanContextValid(spanContext)) return undefined;
	const flags = spanContext.traceFlags & 0x01 ? "01" : "00";
	return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

export async function createLangfuseStreamFn(options?: LangfuseStreamFnOptions): Promise<LangfuseStreamFnResult> {
	const langfuseProcessor = new LangfuseSpanProcessor({
		publicKey: options?.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY,
		secretKey: options?.secretKey ?? process.env.LANGFUSE_SECRET_KEY,
		baseUrl: options?.baseUrl ?? process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_BASEURL,
	});

	const provider = new NodeTracerProvider({
		spanProcessors: [langfuseProcessor],
	});
	provider.register();
	setLangfuseTracerProvider(provider);

	const innerStreamFn = options?.innerStreamFn ?? streamSimple;
	const rootParentSpanContext = parseTraceparent(options?.traceparent ?? process.env.TRACEPARENT);
	const agentTraceStack: AgentTraceEntry[] = [];
	const toolObservations = new Map<string, LangfuseTool>();
	const toolTraceparents = new Map<string, string>();

	function currentAgentEntry(): AgentTraceEntry | undefined {
		return agentTraceStack[agentTraceStack.length - 1];
	}

	function isTraceRoot(): boolean {
		return agentTraceStack.length === 1 && rootParentSpanContext === undefined;
	}

	function createGeneration(
		model: Parameters<StreamFn>[0],
		context: Context,
		streamOptions?: Parameters<StreamFn>[2],
	): LangfuseGeneration {
		const attributes = {
			input: contextToConversationInput(context, streamOptions),
			metadata: {
				api: model.api,
				provider: model.provider,
			},
			model: model.id,
			modelParameters: {
				...(streamOptions?.temperature != null && { temperature: streamOptions.temperature }),
				...(streamOptions?.maxTokens != null && { maxTokens: streamOptions.maxTokens }),
				messageCount: context.messages.length,
				toolCount: context.tools?.length ?? 0,
			},
		};

		const parentAgent = currentAgentEntry()?.observation;
		if (parentAgent) {
			return parentAgent.startObservation("gen_ai.chat", attributes, { asType: "generation" });
		}

		return startObservation("gen_ai.chat", attributes, {
			asType: "generation",
			...(rootParentSpanContext && { parentSpanContext: rootParentSpanContext }),
		});
	}

	const wrappedStreamFn: StreamFn = (model, context, streamOptions) => {
		const parentAgentEntry = currentAgentEntry();
		if (parentAgentEntry && !parentAgentEntry.inputCaptured) {
			const input = contextToAgentInput(model, context, streamOptions);
			parentAgentEntry.observation.update({ input });
			if (isTraceRoot()) {
				parentAgentEntry.observation.updateTrace({ input });
			}
			parentAgentEntry.inputCaptured = true;
		}

		const generation = createGeneration(model, context, streamOptions);
		const wrappedStream = new AssistantMessageEventStream();

		void pipeWithGeneration(innerStreamFn(model, context, streamOptions), wrappedStream, generation);

		return wrappedStream;
	};

	return {
		streamFn: wrappedStreamFn,

		startTrace: (name?: string, input?: unknown, attributes?: Record<string, unknown>, sessionId?: string) => {
			const parentAgent = currentAgentEntry()?.observation;
			const observation = parentAgent
				? parentAgent.startObservation(
						name ?? "agent.prompt",
						{
							...(input !== undefined && { input }),
							...(attributes && Object.keys(attributes).length > 0 && { metadata: attributes }),
						},
						{ asType: "agent" },
					)
				: startObservation(
						name ?? "agent.prompt",
						{
							...(input !== undefined && { input }),
							...(attributes && Object.keys(attributes).length > 0 && { metadata: attributes }),
						},
						{
							asType: "agent",
							...(rootParentSpanContext && { parentSpanContext: rootParentSpanContext }),
						},
					);

			if (agentTraceStack.length === 0 && rootParentSpanContext === undefined) {
				observation.updateTrace({
					...(attributes && Object.keys(attributes).length > 0 && { metadata: attributes }),
					name: name ?? "agent.prompt",
					...(input !== undefined && { input }),
					...(sessionId && { sessionId }),
				});
			}

			agentTraceStack.push({ observation, inputCaptured: input !== undefined });
		},

		endTrace: (output?: unknown) => {
			const entry = agentTraceStack.pop();
			if (!entry) return;

			if (output !== undefined) {
				entry.observation.update({ output });
				if (agentTraceStack.length === 0 && rootParentSpanContext === undefined) {
					entry.observation.updateTrace({ output });
				}
			}

			entry.observation.end();
		},

		beforeToolCall: async (context) => {
			const parentAgent = currentAgentEntry()?.observation;
			const toolObservation = parentAgent
				? parentAgent.startObservation(
						context.toolCall.name,
						{
							input: context.toolCall.arguments,
						},
						{ asType: "tool" },
					)
				: startObservation(
						context.toolCall.name,
						{
							input: context.toolCall.arguments,
						},
						{
							asType: "tool",
							...(rootParentSpanContext && { parentSpanContext: rootParentSpanContext }),
						},
					);

			toolObservations.set(context.toolCall.id, toolObservation);
			const traceparent = spanContextToTraceparent(toolObservation.otelSpan.spanContext());
			if (traceparent) {
				toolTraceparents.set(context.toolCall.id, traceparent);
				process.env.TRACEPARENT = traceparent;
			}

			return undefined;
		},

		afterToolCall: async (context) => {
			const toolObservation = toolObservations.get(context.toolCall.id);
			if (toolObservation) {
				const output = context.result.content
					.filter((content) => content.type === "text")
					.map((content) => content.text ?? "")
					.join("\n");
				toolObservation.update({
					output,
					...(context.isError && {
						level: "ERROR",
						statusMessage: output,
					}),
				});
				toolObservation.end();
				toolObservations.delete(context.toolCall.id);
				toolTraceparents.delete(context.toolCall.id);
			}

			const traceparent = spanContextToTraceparent(currentAgentEntry()?.observation.otelSpan.spanContext());
			if (traceparent) {
				process.env.TRACEPARENT = traceparent;
			} else {
				delete process.env.TRACEPARENT;
			}

			return undefined;
		},

		getTraceparent: (toolCallId?: string) => {
			// Per-tool-call lookup for parallel safety
			if (toolCallId) {
				const tp = toolTraceparents.get(toolCallId);
				if (tp) return tp;
			}

			const envTraceparent = process.env.TRACEPARENT;
			if (envTraceparent) return envTraceparent;

			const spanContext =
				currentAgentEntry()?.observation.otelSpan.spanContext() ??
				trace.getSpan(otelContext.active())?.spanContext();
			return spanContextToTraceparent(spanContext);
		},

		shutdown: async () => {
			await langfuseProcessor.forceFlush();
			await langfuseProcessor.shutdown();
			setLangfuseTracerProvider(null);
		},
	};
}

async function pipeWithGeneration(
	sourceOrPromise: AsyncIterable<AssistantMessageEvent> | Promise<AsyncIterable<AssistantMessageEvent>>,
	target: AssistantMessageEventStream,
	generation: LangfuseGeneration,
): Promise<void> {
	try {
		const source = await sourceOrPromise;
		for await (const event of source) {
			target.push(event);

			if (event.type === "done") {
				const message = event.message;
				generation.update({
					costDetails: {
						cacheRead: message.usage.cost.cacheRead,
						cacheWrite: message.usage.cost.cacheWrite,
						input: message.usage.cost.input,
						output: message.usage.cost.output,
						total: message.usage.cost.total,
					},
					metadata: {
						api: message.api,
						provider: message.provider,
						stopReason: message.stopReason,
					},
					model: message.model,
					output: message.content,
					usageDetails: {
						cacheRead: message.usage.cacheRead,
						cacheWrite: message.usage.cacheWrite,
						input: message.usage.input,
						output: message.usage.output,
						total: message.usage.totalTokens,
					},
				});
				generation.end();
			} else if (event.type === "error") {
				const message = event.error;
				generation.update({
					costDetails: {
						input: message.usage.cost.input,
						output: message.usage.cost.output,
						total: message.usage.cost.total,
					},
					level: "ERROR",
					metadata: {
						api: message.api,
						provider: message.provider,
						stopReason: message.stopReason,
					},
					model: message.model,
					output: message.errorMessage ?? "Unknown error",
					statusMessage: message.errorMessage ?? "Unknown error",
					usageDetails: {
						input: message.usage.input,
						output: message.usage.output,
					},
				});
				generation.end();
			}
		}
	} catch (error) {
		generation.update({
			level: "ERROR",
			output: error instanceof Error ? error.message : String(error),
			statusMessage: error instanceof Error ? error.message : String(error),
		});
		generation.end();
		target.end();
	}
}
