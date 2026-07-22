import type { WorkflowInputs, WorkflowTemplate } from "./workflow-registry";
import { injectWorkflowParameters } from "./workflow-registry";

export const COMFYUI_REPOSITORY = "https://github.com/comfyanonymous/ComfyUI.git";
export const COMFYUI_COMMIT = "da2608926eaf68fd532bba4e1ace3402c5d21399";
export const COMFYUI_BIND_HOST = "127.0.0.1";
export const COMFYUI_PORT = 8188;

export type ComfyPromptStatus = "queued" | "running" | "completed" | "interrupted" | "failed";

export type ComfyPromptRecord = {
  promptId: string;
  status: ComfyPromptStatus;
  progress: number;
  workflowVersion: string;
  outputPaths: string[];
  error?: string;
};

export type ComfyRuntimeClient = {
  health(): Promise<{ ok: boolean; bindHost: string; commit: string }>;
  submitWorkflow(workflow: WorkflowTemplate, inputs: WorkflowInputs): Promise<{ promptId: string }>;
  getPromptStatus(promptId: string): Promise<ComfyPromptRecord>;
  interrupt(promptId: string): Promise<ComfyPromptRecord>;
  getOutputs(promptId: string): Promise<string[]>;
  cleanupModelCache(): Promise<{ removedBytes: number }>;
};

export class MockComfyRuntimeClient implements ComfyRuntimeClient {
  private prompts = new Map<string, ComfyPromptRecord>();
  private sequence = 0;

  async health() {
    return { ok: true, bindHost: COMFYUI_BIND_HOST, commit: COMFYUI_COMMIT };
  }

  async submitWorkflow(workflow: WorkflowTemplate, inputs: WorkflowInputs) {
    injectWorkflowParameters(workflow, inputs);
    this.sequence += 1;
    const promptId = `mock-prompt-${this.sequence}`;
    this.prompts.set(promptId, {
      promptId,
      status: "queued",
      progress: 0,
      workflowVersion: workflow.version,
      outputPaths: [],
    });
    return { promptId };
  }

  async getPromptStatus(promptId: string) {
    const record = this.getRecord(promptId);
    if (record.status === "queued") {
      record.status = "running";
      record.progress = 40;
    } else if (record.status === "running") {
      record.status = "completed";
      record.progress = 100;
      record.outputPaths = [`/workspace/outputs/${promptId}/output.mock`];
    }
    return { ...record, outputPaths: [...record.outputPaths] };
  }

  async interrupt(promptId: string) {
    const record = this.getRecord(promptId);
    if (record.status !== "completed" && record.status !== "failed") {
      record.status = "interrupted";
      record.progress = Math.min(record.progress, 99);
    }
    return { ...record, outputPaths: [...record.outputPaths] };
  }

  async getOutputs(promptId: string) {
    const record = this.getRecord(promptId);
    if (record.status !== "completed") {
      return [];
    }
    return [...record.outputPaths];
  }

  async cleanupModelCache() {
    return { removedBytes: 0 };
  }

  private getRecord(promptId: string) {
    const record = this.prompts.get(promptId);
    if (!record) throw new Error(`unknown prompt id: ${promptId}`);
    return record;
  }
}
