import type { AgentRequest, AgentResponse, ModelAdapter, ModelInfo, StreamChunk } from '@orchestrator/shared';

export abstract class BaseAdapter implements ModelAdapter {
  abstract readonly provider: string;

  abstract createResponse(request: AgentRequest): Promise<AgentResponse>;

  abstract streamResponse(request: AgentRequest): AsyncIterable<StreamChunk>;

  abstract listModels(): Promise<ModelInfo[]>;

  protected extractModelName(modelId: string): string {
    const slash = modelId.indexOf('/');
    return slash === -1 ? modelId : modelId.substring(slash + 1);
  }

  protected buildMessages(
    request: AgentRequest
  ): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];

    if (request.instructions) {
      messages.push({ role: 'system', content: request.instructions });
    }

    if (typeof request.input === 'string') {
      messages.push({ role: 'user', content: request.input });
    } else {
      for (const msg of request.input) {
        const content =
          typeof msg.content === 'string'
            ? msg.content
            : msg.content
                .filter((b) => b.type === 'text' && b.text)
                .map((b) => b.text!)
                .join('\n');
        messages.push({ role: msg.role, content });
      }
    }

    return messages;
  }

  protected generateId(): string {
    return crypto.randomUUID();
  }
}
