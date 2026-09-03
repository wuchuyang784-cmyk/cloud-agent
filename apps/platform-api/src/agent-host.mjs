export function agentHost(agentId) {
  const normalizedId = String(agentId).replace(/^agent-/, '');
  return 'agent-' + normalizedId + '.localhost';
}
