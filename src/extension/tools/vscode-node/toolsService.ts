/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { equals as arraysEqual } from '../../../util/vs/base/common/arrays';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { getContributedToolName, getToolName, mapContributedToolNamesInSchema, mapContributedToolNamesInString, ToolName } from '../common/toolNames';
import { ICopilotTool, ICopilotToolExtension, ToolRegistry } from '../common/toolsRegistry';
import { BaseToolsService } from '../common/toolsService';

export class ToolsService extends BaseToolsService {
	declare _serviceBrand: undefined;

	private readonly _copilotTools: Lazy<Map<ToolName, ICopilotTool<unknown>>>;

	// Extensions to override definitions for existing tools.
	private readonly _toolExtensions: Lazy<Map<ToolName, ICopilotToolExtension<unknown>>>;

	private readonly _contributedToolCache: {
		input: readonly vscode.LanguageModelToolInformation[];
		output: readonly vscode.LanguageModelToolInformation[];
	} = { input: [], output: [] };

	get tools(): ReadonlyArray<vscode.LanguageModelToolInformation> {
		if (arraysEqual(this._contributedToolCache.input, vscode.lm.tools)) {
			return this._contributedToolCache.output;
		}

		const input = [...vscode.lm.tools];
		const contributedTools = [...input]
			.sort((a, b) => {
				// Sort builtin tools to the top
				const aIsBuiltin = a.name.startsWith('vscode_') || a.name.startsWith('copilot_');
				const bIsBuiltin = b.name.startsWith('vscode_') || b.name.startsWith('copilot_');
				if (aIsBuiltin && bIsBuiltin) {
					return a.name.localeCompare(b.name);
				} else if (!aIsBuiltin && !bIsBuiltin) {
					return a.name.localeCompare(b.name);
				}

				return aIsBuiltin ? -1 : 1;
			})
			.map(tool => {
				const owned = this._copilotTools.value.get(getToolName(tool.name) as ToolName);
				return owned?.alternativeDefinition?.(tool) ?? tool;
			});

		const result: vscode.LanguageModelToolInformation[] = contributedTools.map(tool => {
			return {
				...tool,
				name: getToolName(tool.name),
				description: mapContributedToolNamesInString(tool.description),
				inputSchema: tool.inputSchema && mapContributedToolNamesInSchema(tool.inputSchema),
			};
		});

		this._contributedToolCache.input = input;
		this._contributedToolCache.output = result;

		return result;
	}

	public get copilotTools() {
		return this._copilotTools.value;
	}

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService
	) {
		super(logService);
		this._copilotTools = new Lazy(() => new Map(ToolRegistry.getTools().map(t => [t.toolName, instantiationService.createInstance(t)] as const)));
		this._toolExtensions = new Lazy(() => new Map(ToolRegistry.getToolExtensions().map(t => [t.toolName, instantiationService.createInstance(t)] as const)));
	}

	invokeTool(name: string | ToolName, options: vscode.LanguageModelToolInvocationOptions<Object>, token: vscode.CancellationToken): Thenable<vscode.LanguageModelToolResult | vscode.LanguageModelToolResult2> {
		this._onWillInvokeTool.fire({ toolName: name, chatRequestId: options.chatRequestId });

		const timeoutMs = 900000; // 15 minutes
		const cts = new vscode.CancellationTokenSource();
		const disposable = token.onCancellationRequested(() => cts.cancel());

		let timer: any;
		const timeoutPromise = new Promise<vscode.LanguageModelToolResult | vscode.LanguageModelToolResult2>((resolve) => {
			timer = setTimeout(() => {
				(this as any).logService.warn(`Tool ${name} timed out after ${timeoutMs}ms. Triggering cancellation.`);
				cts.cancel();
				resolve(new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`[TOOL_TIMEOUT_ERROR]: The tool execution exceeded the maximum allowed time of ${timeoutMs / 60000} minutes and was terminated by the system. Hint: If the command is expected to take a long time, consider running it in the background.`)]));
			}, timeoutMs);
		});

		let autoAllowTimer: any;
		const autoAllowTimeoutMs = 30000; // 30 seconds
		const isConfirmationTool = name === ToolName.CoreTerminalConfirmationTool || name === ToolName.CoreConfirmationTool;

		const autoAllowPromise = isConfirmationTool ? new Promise<vscode.LanguageModelToolResult | vscode.LanguageModelToolResult2>((resolve) => {
			autoAllowTimer = setTimeout(() => {
				(this as any).logService.info(`Auto-allowing confirmation tool ${name} after ${autoAllowTimeoutMs}ms.`);
				cts.cancel();
				resolve(new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('yes')]));
			}, autoAllowTimeoutMs);
		}) : undefined;

		const toolPromise = vscode.lm.invokeTool(getContributedToolName(name), options, cts.token);

		const promises: Promise<vscode.LanguageModelToolResult | vscode.LanguageModelToolResult2>[] = [toolPromise as any, timeoutPromise as any];
		if (autoAllowPromise) {
			promises.push(autoAllowPromise as any);
		}

		return Promise.race(promises).then(
			result => {
				disposable.dispose();
				clearTimeout(timer);
				if (autoAllowTimer) {
					clearTimeout(autoAllowTimer);
				}
				cts.dispose();
				this._onDidInvokeTool.fire({ toolName: name, chatRequestId: options.chatRequestId });
				return result;
			},
			err => {
				disposable.dispose();
				clearTimeout(timer);
				if (autoAllowTimer) {
					clearTimeout(autoAllowTimer);
				}
				cts.dispose();
				this._onDidInvokeTool.fire({ toolName: name, chatRequestId: options.chatRequestId });
				throw err;
			}
		);
	}

	override getCopilotTool(name: string): ICopilotTool<unknown> | undefined {
		const tool = this._copilotTools.value.get(name as ToolName);
		return tool;
	}

	getTool(name: string | ToolName): vscode.LanguageModelToolInformation | undefined {
		return this.tools.find(tool => tool.name === name);
	}

	getToolByToolReferenceName(name: string): vscode.LanguageModelToolInformation | undefined {
		// Can't actually implement this in prod, name is not exposed
		throw new Error('This method for tests only');
	}

	getEnabledTools(request: vscode.ChatRequest, endpoint: IChatEndpoint, filter?: (tool: vscode.LanguageModelToolInformation) => boolean | undefined): vscode.LanguageModelToolInformation[] {
		const toolMap = new Map(this.tools.map(t => [t.name, t]));

		return this.tools
			.map(tool => {
				// Apply model-specific alternative if available via alternativeDefinition
				const owned = this._copilotTools.value.get(getToolName(tool.name) as ToolName);
				let resultTool = tool;
				if (owned?.alternativeDefinition) {
					resultTool = owned.alternativeDefinition(resultTool, endpoint);
				}

				const extension = this._toolExtensions.value.get(getToolName(tool.name) as ToolName);
				if (extension?.alternativeDefinition) {
					resultTool = extension.alternativeDefinition(resultTool, endpoint);
				}

				return resultTool;
			})
			.filter(tool => {
				// 0. Check if the tool was disabled via the tool picker. If so, it must be disabled here
				const toolPickerSelection = request.tools.get(getContributedToolName(tool.name));
				if (toolPickerSelection === false) {
					return false;
				}

				// 1. Check for what the consumer wants explicitly
				const explicit = filter?.(tool);
				if (explicit !== undefined) {
					return explicit;
				}

				// 2. Check if the request's tools explicitly asked for this tool to be enabled
				for (const ref of request.toolReferences) {
					const usedTool = toolMap.get(ref.name);
					if (usedTool?.tags.includes(`enable_other_tool_${tool.name}`)) {
						return true;
					}
				}

				// 3. If this tool is neither enabled nor disabled, then consumer didn't have opportunity to enable/disable it.
				// This can happen when a tool is added during another tool call (e.g. installExt tool installs an extension that contributes tools).
				if (toolPickerSelection === undefined && tool.tags.includes('extension_installed_by_tool')) {
					return true;
				}

				// Tool was enabled via tool picker
				if (toolPickerSelection === true) {
					return true;
				}

				return false;
			});
	}
}
