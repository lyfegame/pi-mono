import { beforeEach, describe, expect, it, vi } from "vitest";

import { getModel } from "../src/models.js";
import type { AssistantMessage, Context } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

interface ObservationCall {
	name: string;
	attributes: Record<string, unknown>;
	options: Record<string, unknown> | undefined;
}

const mockState = vi.hoisted(() => ({
	observations: [] as ObservationCall[],
}));

class FakeObservation {
	name: string;
	attributes: Record<string, unknown>;
	options: Record<string, unknown> | undefined;
	otelSpan = {
		spanContext: () => ({
			traceId: "1234567890abcdef1234567890abcdef",
			spanId: "1234567890abcdef",
			traceFlags: 1,
			isRemote: false,
		}),
	};

	constructor(name: string, attributes: Record<string, unknown>, options?: Record<string, unknown>) {
		this.name = name;
		this.attributes = attributes;
		this.options = options;
		mockState.observations.push({ name, attributes, options });
	}

	update(_payload: Record<string, unknown>) {}
	updateTrace(_payload: Record<string, unknown>) {}
	end() {}
	startObservation(name: string, attributes: Record<string, unknown>, options?: Record<string, unknown>) {
		return new FakeObservation(name, attributes, options);
	}
}

vi.mock("@langfuse/otel", () => ({
	LangfuseSpanProcessor: class {
		async forceFlush() {}
		async shutdown() {}
	},
}));

vi.mock("@langfuse/tracing", () => ({
	setLangfuseTracerProvider: vi.fn(),
	startObservation: (name: string, attributes: Record<string, unknown>, options?: Record<string, unknown>) =>
		new FakeObservation(name, attributes, options),
}));

vi.mock("@opentelemetry/api", () => ({
	context: {
		active: () => ({}),
	},
	isSpanContextValid: () => true,
	trace: {
		getSpan: () => undefined,
	},
}));

vi.mock("@opentelemetry/sdk-trace-node", () => ({
	NodeTracerProvider: class {
		register() {}
	},
}));

import { createLangfuseStreamFn } from "../src/langfuse.js";

function buildUsage() {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function buildDoneEvent(message: AssistantMessage): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
	});
	return stream;
}

function findAssistantMessageWithToolCalls(input: unknown): { content: unknown; tool_calls: unknown[] } | undefined {
	if (!Array.isArray(input)) return undefined;
	for (const item of input) {
		if (typeof item !== "object" || item === null) continue;
		const candidate = item as { role?: unknown; content?: unknown; tool_calls?: unknown[] };
		if (candidate.role === "assistant" && Array.isArray(candidate.tool_calls) && candidate.tool_calls.length > 0) {
			return { content: candidate.content, tool_calls: candidate.tool_calls };
		}
	}
	return undefined;
}

describe("Langfuse observability transcript mapping", () => {
	beforeEach(() => {
		mockState.observations = [];
	});

	it("adds a reasoning summary to tool-only assistant turns in trace input", async () => {
		const instrumented = await createLangfuseStreamFn({
			baseUrl: "https://langfuse.example",
			publicKey: "pk-test",
			secretKey: "sk-test",
			innerStreamFn: () =>
				buildDoneEvent({
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.4",
					usage: buildUsage(),
					stopReason: "stop",
					timestamp: Date.now(),
				}),
		});

		const model = getModel("openai", "gpt-5.4");
		const context: Context = {
			systemPrompt: "You are helpful.",
			messages: [
				{ role: "user", content: "check health", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "I should inspect the latest Langfuse evidence before recommending an action.",
						},
						{ type: "toolCall", id: "call_1", name: "shell", arguments: { command: "echo hi" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.4",
					usage: buildUsage(),
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "shell",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: "what now?", timestamp: 4 },
			],
		};

		const stream = await instrumented.streamFn(model, context);
		await stream.result();

		const generation = mockState.observations.find((observation) => observation.name === "gen_ai.chat");
		expect(generation).toBeTruthy();
		const assistantEntry = findAssistantMessageWithToolCalls(generation?.attributes.input);
		expect(assistantEntry).toBeTruthy();
		expect(assistantEntry?.content).toBe(
			"[pi observability] reasoning summary: I should inspect the latest Langfuse evidence before recommending an action.",
		);
		expect(assistantEntry?.tool_calls).toHaveLength(1);
	});

	it("uses a placeholder when reasoning is captured only via signature", async () => {
		const instrumented = await createLangfuseStreamFn({
			baseUrl: "https://langfuse.example",
			publicKey: "pk-test",
			secretKey: "sk-test",
			innerStreamFn: () =>
				buildDoneEvent({
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.4",
					usage: buildUsage(),
					stopReason: "stop",
					timestamp: Date.now(),
				}),
		});

		const model = getModel("openai", "gpt-5.4");
		const context: Context = {
			messages: [
				{ role: "user", content: "check health", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "", thinkingSignature: '{"id":"rs_123"}', redacted: true },
						{ type: "toolCall", id: "call_1", name: "shell", arguments: { command: "echo hi" } },
					],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5.4",
					usage: buildUsage(),
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "shell",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 3,
				},
			],
		};

		const stream = await instrumented.streamFn(model, context);
		await stream.result();

		const generation = mockState.observations.find((observation) => observation.name === "gen_ai.chat");
		const assistantEntry = findAssistantMessageWithToolCalls(generation?.attributes.input);
		expect(assistantEntry?.content).toBe("[pi observability] reasoning captured in generation output");
	});
});
