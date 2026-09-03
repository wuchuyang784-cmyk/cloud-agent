export class MockRuntime {
  constructor(options = {}) {
    this.host = options.host ?? 'http://mock-runtime';
  }

  async provision(agent) {
    return { runtimeUrl: this.host + '/runtimes/' + agent.id };
  }

  async streamChat({ agent, message, writeEvent }) {
    writeEvent('run.started', { agentId: agent.id });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const content = '模拟 Runtime 已收到：' + message;
    writeEvent('message.completed', { role: 'assistant', content });
    writeEvent('run.completed', { usage: { totalTokens: content.length } });
    return { totalTokens: content.length };
  }
}
