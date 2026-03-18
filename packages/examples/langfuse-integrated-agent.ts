/**
 * Example: Langfuse-integrated multi-agent orchestration with expert discovery.
 *
 * Experts are defined as markdown files in packages/examples/experts/.
 * The parent agent has two tools:
 *   - find_experts: discover available experts and their domains
 *   - delegate_to_expert: delegate a task to a named expert
 *
 * Each expert runs as a separate `pi` process with:
 *   - Its own custom system prompt (from the .md file body)
 *   - A dedicated session file persisted under .context/
 *   - TRACEPARENT propagation so the full trace tree appears in Langfuse
 *
 * Usage:
 *   npm run build   # from repo root
 *   node --experimental-strip-types packages/examples/langfuse-integrated-agent.ts
 *   node --experimental-strip-types packages/examples/langfuse-integrated-agent.ts "your custom prompt here"
 *
 * Required env vars: LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_BASE_URL, OPENAI_API_KEY
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AssistantMessage, TextContent } from "../ai/dist/index.js";
import { Type, getModel } from "../ai/dist/index.js";
import { createLangfuseStreamFn } from "../ai/dist/langfuse.js";
import { Agent, type AgentMessage } from "../agent/dist/index.js";

// ── Expert discovery ────────────────────────────────────────────────────────

interface ExpertSpec {
	name: string;
	description: string;
	domains: string[];
	modelId: string;
	tools: string[];
	systemPrompt: string;
	filePath: string;
}

/**
 * Parse a markdown expert file with YAML-like frontmatter.
 *
 * Expected format:
 * ```
 * ---
 * name: scout
 * description: Fast codebase reconnaissance
 * domains: code exploration, file discovery, architecture mapping
 * model: openai/gpt-4.1-mini
 * tools: read, grep, find, ls
 * ---
 * You are a scout subagent...
 * ```
 */
function parseExpertFile(filePath: string): ExpertSpec | undefined {
	const content = readFileSync(filePath, "utf-8");
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return undefined;

	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();
		frontmatter[key] = value;
	}

	if (!frontmatter.name || !frontmatter.description) return undefined;

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		domains: (frontmatter.domains ?? "")
			.split(",")
			.map((d) => d.trim())
			.filter(Boolean),
		modelId: frontmatter.model ?? "openai/gpt-4.1-mini",
		tools: (frontmatter.tools ?? "read")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean),
		systemPrompt: match[2].trim(),
		filePath,
	};
}

function discoverExperts(expertsDir: string): ExpertSpec[] {
	if (!existsSync(expertsDir)) return [];
	const experts: ExpertSpec[] = [];
	for (const file of readdirSync(expertsDir)) {
		if (!file.endsWith(".md")) continue;
		const spec = parseExpertFile(join(expertsDir, file));
		if (spec) experts.push(spec);
	}
	return experts;
}

// ── Run directories ─────────────────────────────────────────────────────────

const repoRoot = resolve(import.meta.dirname, "../..");
const expertsDir = resolve(import.meta.dirname, "experts");
const runLabel = new Date().toISOString().replace(/[:.]/g, "-");
const runRootDir = resolve(repoRoot, ".context", "langfuse-integrated-agent", runLabel);
const sessionsRootDir = join(runRootDir, "sessions");
mkdirSync(sessionsRootDir, { recursive: true });

// ── Discover experts ────────────────────────────────────────────────────────

const experts = discoverExperts(expertsDir);
const expertsByName = new Map(experts.map((e) => [e.name, e]));

console.log(`--- Langfuse integrated agent ---`);
console.log(`Experts dir: ${expertsDir}`);
console.log(`Found ${experts.length} expert(s): ${experts.map((e) => e.name).join(", ") || "(none)"}`);
console.log(`Artifacts: ${runRootDir}`);

if (experts.length === 0) {
	console.error("\nNo experts found. Create .md files in packages/examples/experts/");
	console.error("See packages/examples/experts/scout.md for the format.");
	process.exit(1);
}

// ── Langfuse tracing ────────────────────────────────────────────────────────

const lf = await createLangfuseStreamFn();
const parentModel = getModel("openai", "gpt-4.1-mini");

// ── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return "role" in message && message.role === "assistant";
}

function isTextContent(content: AssistantMessage["content"][number]): content is TextContent {
	return content.type === "text";
}

function lastAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (isAssistantMessage(msg)) {
			return msg.content.filter(isTextContent).map((c) => c.text).join("");
		}
	}
	return "";
}

function getSessionFile(sessionDir: string): string | undefined {
	const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).sort();
	return files.at(-1) ? join(sessionDir, files.at(-1)!) : undefined;
}

// ── Subagent spawner ────────────────────────────────────────────────────────

interface ExpertRun {
	expertName: string;
	task: string;
	sessionDir: string;
	sessionFile?: string;
	sessionId?: string;
	output: string;
	exitCode: number | null;
}

const expertRuns: ExpertRun[] = [];

async function spawnExpert(spec: ExpertSpec, task: string, toolCallId?: string): Promise<ExpertRun> {
	const sessionDir = mkdtempSync(join(sessionsRootDir, `${spec.name}-`));
	const traceparent = lf.getTraceparent(toolCallId);
	const env = { ...process.env };
	if (traceparent) env.TRACEPARENT = traceparent;
	env.PI_TRACE_NAME = spec.name;

	const args = [
		join(repoRoot, "packages/coding-agent/dist/cli.js"),
		"--mode", "json",
		"-p",
		"--session-dir", sessionDir,
		"--model", spec.modelId,
		"--tools", spec.tools.join(","),
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--system-prompt", spec.systemPrompt,
		`Task: ${task}`,
	];

	return new Promise((resolvePromise, reject) => {
		const proc = spawn("node", args, {
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});

		let stdoutBuffer = "";
		let stderrBuffer = "";
		let finalOutput = "";
		let sessionId: string | undefined;

		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: Record<string, unknown> | undefined;
			try {
				const parsed = JSON.parse(line) as unknown;
				event = isRecord(parsed) ? parsed : undefined;
			} catch { return; }
			if (!event) return;
			if (event.type === "session" && typeof event.id === "string") {
				sessionId = event.id;
			}
			if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
				const content = event.message.content;
				if (Array.isArray(content)) {
					const texts = content
						.filter((c): c is Record<string, unknown> => isRecord(c) && c.type === "text" && typeof c.text === "string")
						.map((c) => c.text as string);
					if (texts.length) finalOutput = texts.join("");
				}
			}
		};

		proc.stdout.on("data", (chunk: Buffer) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (chunk: Buffer) => {
			stderrBuffer += chunk.toString();
			process.stderr.write(chunk);
		});

		proc.on("close", (code: number | null) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			resolvePromise({
				expertName: spec.name,
				task,
				sessionDir,
				sessionFile: getSessionFile(sessionDir),
				sessionId,
				output: finalOutput || stderrBuffer.trim() || (code === 0 ? "(no output)" : `(exited ${code})`),
				exitCode: code,
			});
		});

		proc.on("error", reject);
	});
}

// ── Parent agent with find_experts + delegate_to_expert ─────────────────────

const parent = new Agent({
	streamFn: lf.streamFn,
	beforeToolCall: async (ctx) => lf.beforeToolCall({ toolCall: ctx.toolCall }),
	afterToolCall: async (ctx) =>
		lf.afterToolCall({
			toolCall: ctx.toolCall,
			result: ctx.result,
			isError: ctx.isError,
		}),
	initialState: {
		systemPrompt: [
			"You are an orchestrator agent. You delegate work to domain experts.",
			"",
			"Workflow:",
			"1. Call find_experts to see which experts are available and what domains they cover.",
			"2. Call delegate_to_expert with the expert name and a clear task.",
			"3. You can delegate to multiple experts (in parallel if independent).",
			"4. Synthesize the results into a coherent response.",
		].join("\n"),
		model: parentModel,
		thinkingLevel: "off",
		tools: [
			{
				name: "find_experts",
				label: "Find Experts",
				description: "List all available experts with their names, descriptions, and domains.",
				parameters: Type.Object({}),
				execute: async () => {
					const listing = experts.map((e) => ({
						name: e.name,
						description: e.description,
						domains: e.domains,
						tools: e.tools,
						model: e.modelId,
					}));
					return {
						content: [{ type: "text" as const, text: JSON.stringify(listing, null, 2) }],
						details: {},
					};
				},
			},
			{
				name: "delegate_to_expert",
				label: "Delegate to Expert",
				description: "Delegate a task to a named expert. The expert runs as a separate process with its own context window and tools.",
				parameters: Type.Object({
					expert: Type.String({ description: "Name of the expert (from find_experts)" }),
					task: Type.String({ description: "Task to delegate" }),
				}),
				execute: async (toolCallId: string, params: { expert: string; task: string }) => {
					const spec = expertsByName.get(params.expert);
					if (!spec) {
						const available = experts.map((e) => e.name).join(", ");
						return {
							content: [{ type: "text" as const, text: `Unknown expert "${params.expert}". Available: ${available}` }],
							details: {},
						};
					}
					console.log(`\n[${spec.name}] ${params.task.slice(0, 100)}`);
					const run = await spawnExpert(spec, params.task, toolCallId);
					expertRuns.push(run);
					return {
						content: [{ type: "text" as const, text: run.output }],
						details: run,
					};
				},
			},
		],
	},
});

parent.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

// ── Run ─────────────────────────────────────────────────────────────────────

const userPrompt = process.argv[2] ?? [
	"Investigate how the Langfuse tracing integration works in this repository.",
	"Find which experts are available, then delegate appropriately.",
	"Finish with a concise synthesis.",
].join(" ");

lf.startTrace("langfuse-integrated-agent", userPrompt);
await parent.prompt(userPrompt);

const finalText = lastAssistantText(parent.state.messages);
lf.endTrace(finalText);

console.log("\n\n--- Expert runs ---");
for (const run of expertRuns) {
	console.log(`- ${run.expertName}: ${run.sessionFile ?? "(no session file)"}`);
	if (run.sessionId) console.log(`  sessionId: ${run.sessionId}`);
}

console.log("\n--- Done ---");
await new Promise((r) => setTimeout(r, 5000));
await lf.shutdown();
console.log("Traces flushed.");
