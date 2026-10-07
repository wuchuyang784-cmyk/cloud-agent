import assert from 'node:assert/strict';

export function viewerGrantCommand(containerId, userId) {
  assert.match(containerId, /^[a-f0-9]{12,64}$/);
  assert.match(userId, /^[a-zA-Z0-9_-]{1,200}$/);
  return {
    args: ['exec', '-i', containerId, 'psql', '-U', 'postgres', '-d', 'bairui_preprod', '--set=uid=' + userId, '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    input: "INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) VALUES (:'uid','platform_viewer','preprod-acceptance','unified monitoring acceptance') ON CONFLICT (user_id) DO UPDATE SET role='platform_viewer',revoked_at=NULL,granted_at=now(),granted_by='preprod-acceptance',reason='unified monitoring acceptance';\n",
  };
}
