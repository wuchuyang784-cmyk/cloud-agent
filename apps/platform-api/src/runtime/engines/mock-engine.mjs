// 平台内置 Mock 引擎：进程内模拟 Agent 运行体。
// 负责 Agent 创建后的 provision 状态流转与 SSE 对话回显；仅在真实引擎
// （pi/dsh adapter）接入并 canRun() 通过前作为统一 fallback 使用。

export class MockEngineAdapter {
  constructor(options = {}) {
    this.engine = 'mock';
    this.host = options.host ?? 'http://mock-runtime';
  }

  /** Mock 始终就绪。 */
  canRun() {
    return { ok: true, reason: null };
  }

  /** 对齐 worker / app 创建流程的 provision 语义。 */
  async provision(agent) {
    return { runtimeUrl: this.host + '/runtimes/' + agent.id };
  }

  /** 对齐对话 SSE 的 streamChat 语义（模拟回显）。 */
  async streamChat({ agent, message, writeEvent }) {
    writeEvent('run.started', { agentId: agent.id });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const content = '模拟 Runtime 已收到：' + message;
    writeEvent('message.completed', { role: 'assistant', content });
    writeEvent('run.completed', { usage: { totalTokens: content.length } });
    return { totalTokens: content.length };
  }

  /** EngineAdapter 契约的只读健康检查（对话本体仍走平台内 streamChat）。 */
  async health() {
    return { status: 'running', engine: 'mock' };
  }
}
