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

function generationMessages(input: unknown): unknown[] | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const candidate = input as { messages?: unknown[] };
	return Array.isArray(candidate.messages) ? candidate.messages : undefined;
}

function hasToolCallContent(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some((item) => {
		if (typeof item !== "object" || item === null) return false;
		const candidate = item as { type?: unknown };
		return candidate.type === "toolCall";
	});
}

function findAssistantMessageWithToolCalls(input: unknown): { content: unknown[] } | undefined {
	const messages = generationMessages(input);
	if (!messages) return undefined;
	for (const item of messages) {
		if (typeof item !== "object" || item === null) continue;
		const candidate = item as { role?: unknown; content?: unknown[] };
		if (candidate.role === "assistant" && hasToolCallContent(candidate.content)) {
			return { content: candidate.content ?? [] };
		}
	}
	return undefined;
}

describe("Langfuse observability transcript mapping", () => {
	beforeEach(() => {
		mockState.observations = [];
	});

	it("preserves original json structure while trimming signature fields from generation input", async () => {
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
							thinking:
								"I should inspect the latest Langfuse evidence before recommending an action. I should keep the full reasoning block visible for observability.",
							thinkingSignature: '{"id":"rs_456"}',
						},
						{ type: "text", text: "I’m checking the latest evidence now.", textSignature: '{"id":"msg_123"}' },
						{
							type: "toolCall",
							id: "call_1",
							name: "shell",
							arguments: { command: "echo hi" },
							thoughtSignature: "tool-thought-123",
						},
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

		const stream = await instrumented.streamFn(model, context, { temperature: 0.4, maxTokens: 256 });
		await stream.result();

		const generation = mockState.observations.find((observation) => observation.name === "gen_ai.chat");
		expect(generation).toBeTruthy();
		expect(generation?.attributes.input).toEqual({
			systemPrompt: "You are helpful.",
			messages: [
				{ role: "user", content: "check health" },
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking:
								"I should inspect the latest Langfuse evidence before recommending an action. I should keep the full reasoning block visible for observability.",
						},
						{ type: "text", text: "I’m checking the latest evidence now." },
						{ type: "toolCall", id: "call_1", name: "shell", arguments: { command: "echo hi" } },
					],
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "shell",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
				{ role: "user", content: "what now?" },
			],
			request: {
				temperature: 0.4,
				maxTokens: 256,
			},
		});
		expect(JSON.stringify(generation?.attributes.input)).not.toContain("[pi observability]");
		expect(JSON.stringify(generation?.attributes.input)).not.toContain("thinkingSignature");
		expect(JSON.stringify(generation?.attributes.input)).not.toContain("textSignature");
		expect(JSON.stringify(generation?.attributes.input)).not.toContain("thoughtSignature");
	});

	it("preserves original thinking blocks when a tool turn has no text", async () => {
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
						{
							type: "thinking",
							thinking:
								"This entire visible reasoning block should be preserved as-is for Langfuse replay input.",
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
			],
		};

		const stream = await instrumented.streamFn(model, context);
		await stream.result();

		const generation = mockState.observations.find((observation) => observation.name === "gen_ai.chat");
		const assistantEntry = findAssistantMessageWithToolCalls(generation?.attributes.input);
		expect(assistantEntry?.content).toEqual([
			{
				type: "thinking",
				thinking: "This entire visible reasoning block should be preserved as-is for Langfuse replay input.",
			},
			{ type: "toolCall", id: "call_1", name: "shell", arguments: { command: "echo hi" } },
		]);
		expect(JSON.stringify(generation?.attributes.input)).not.toContain("[pi observability]");
	});

	it("preserves redacted reasoning blocks while trimming opaque signatures", async () => {
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
		expect(assistantEntry?.content).toEqual([
			{ type: "thinking", thinking: "", redacted: true },
			{ type: "toolCall", id: "call_1", name: "shell", arguments: { command: "echo hi" } },
		]);
		expect(JSON.stringify(generation?.attributes.input)).not.toContain("thinkingSignature");
	});
});
