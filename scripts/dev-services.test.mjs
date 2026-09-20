import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import net from 'node:net';
import { developmentServices } from './dev-services.mjs';
const exec = promisify(execFile);
const env = { BAIRUI_AUTH_MODE: 'better-auth', DATABASE_URL: 'postgresql://test-only' };
test('platform startup selects API and separate client/admin consoles without workers', () => {
  assert.deepEqual(developmentServices(env, 'all').map(item => item.name), ['platform-api', 'admin-console', 'console-mvp']);
  assert.deepEqual(developmentServices(env, 'api').map(item => item.name), ['platform-api']);
  assert.deepEqual(developmentServices({}, 'web').map(item => item.name), ['admin-console', 'console-mvp']);
  assert.throws(() => developmentServices({}, 'api'), /BAIRUI_AUTH_MODE/);
});
test('legacy must be explicit and is forbidden in production', () => {
  assert.equal(developmentServices({ BAIRUI_PLATFORM_MODE: 'legacy' }, 'all').length, 6);
  assert.throws(() => developmentServices({ BAIRUI_PLATFORM_MODE: 'legacy', NODE_ENV: 'production' }, 'all'), /legacy/);
  assert.throws(() => developmentServices(env, 'typo'), /target/);
});

test('development services declare every listening port, including the separate admin console', () => {
  const services = developmentServices({ ...env, PLATFORM_API_PORT: '18080', ADMIN_CONSOLE_PORT: '15174' });
  assert.deepEqual(services.map(service => [service.name, service.listenPort]), [
    ['platform-api', '18080'], ['admin-console', '15174'], ['console-mvp', '5173'],
  ]);
  const legacy = developmentServices({ BAIRUI_PLATFORM_MODE: 'legacy' });
  assert.equal(legacy.find(service => service.name === 'mock-runtime').listenPort, '8090');
  assert.equal(legacy.find(service => service.name === 'runtime-boundary').listenPort, '8091');
  assert.equal(legacy.find(service => service.name === 'platform-worker').listenPort, undefined);
});

test('Windows startup rejects an occupied port before launching and leaves its listener intact', { skip: process.platform !== 'win32' }, async () => {
  const listener = net.createServer(socket => socket.end());
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const source = await readFile(new URL('./dev.ps1', import.meta.url), 'utf8');
    const preflight = source.indexOf('Assert-ServicePortsAvailable -Services $services');
    assert.ok(preflight >= 0 && preflight < source.indexOf('foreach ($service in $services)'), 'preflight must precede process launch');
    const command = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $env:BAIRUI_DEV_TEST_ROOT 'scripts/dev.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-ServicePortsAvailable' }, $true)
if ($null -eq $definition) { throw 'Missing port preflight function' }
. ([scriptblock]::Create($definition.Extent.Text))
$services = @([pscustomobject]@{ name = 'occupied-console'; listenPort = $env:BAIRUI_DEV_TEST_PORT })
try {
    Assert-ServicePortsAvailable -Services $services
    ConvertTo-Json -Compress @{ blocked = $false }
} catch {
    ConvertTo-Json -Compress @{ blocked = $true; message = $_.Exception.Message }
}
Assert-ServicePortsAvailable -Services @([pscustomobject]@{ name = 'worker-without-port' })
$free = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
$free.Start()
$freePort = $free.LocalEndpoint.Port
$free.Stop()
Assert-ServicePortsAvailable -Services @([pscustomobject]@{ name = 'available-console'; listenPort = $freePort })
`;
    const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 20000,
      env: { ...process.env, BAIRUI_DEV_TEST_ROOT: root, BAIRUI_DEV_TEST_PORT: String(listener.address().port) },
    }).catch(error => assert.fail(error.stderr || error.message));
    const result = JSON.parse(stdout);
    assert.equal(result.blocked, true);
    assert.match(result.message, /occupied-console/);
    assert.ok(result.message.includes(String(listener.address().port)));
    assert.ok(result.message.includes(String(process.pid)));
    assert.match(result.message, /Ctrl\+C/);
    assert.equal(listener.listening, true);
  } finally { await new Promise(resolve => listener.close(resolve)); }
});

test('Windows PowerShell 5.1 startup passes one service at a time to path and process helpers', { skip: process.platform !== 'win32' }, async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = await readFile(new URL('./dev.ps1', import.meta.url));
  assert.deepEqual([...source.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'dev.ps1 must retain its UTF-8 BOM');
  // Execute the real parsing/launch loop, replacing only installation and process side effects.
  const command = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$tokens = $null
$parseErrors = $null
$root = $env:BAIRUI_DEV_TEST_ROOT
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'scripts/dev.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$assignment = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$services'
}, $true)
$loop = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.ForEachStatementAst] -and $node.Variable.VariablePath.UserPath -eq 'service'
}, $true)
if ($null -eq $assignment -or $null -eq $loop) { throw 'Startup statements not found' }
$serviceJson = $env:BAIRUI_DEV_TEST_SERVICES
$launched = New-Object System.Collections.Generic.List[object]
function Install-DepsIfMissing {
    param([string]$Directory, [string]$Name)
    if (-not (Test-Path -LiteralPath (Join-Path $Directory 'package.json'))) { throw "Invalid service directory: $Name" }
}
function Start-NodeService {
    param([string]$Name, [string]$WorkDir, [string[]]$Arguments, [string]$Port)
    [void]$launched.Add([pscustomobject]@{ name = $Name; directory = $WorkDir; arguments = $Arguments; port = $Port })
}
. ([scriptblock]::Create($assignment.Extent.Text))
. ([scriptblock]::Create($loop.Extent.Text))
ConvertTo-Json -InputObject @{ version = $PSVersionTable.PSVersion.ToString(); services = $launched.ToArray() } -Depth 4 -Compress
`;
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  for (const mode of ['platform', 'legacy']) {
    for (const target of ['all', 'api', 'web']) {
      await t.test(`${mode}/${target}`, async () => {
        const services = developmentServices({ ...env, BAIRUI_PLATFORM_MODE: mode }, target);
        const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
          windowsHide: true, timeout: 15000,
          env: { ...process.env, BAIRUI_DEV_TEST_ROOT: root, BAIRUI_DEV_TEST_SERVICES: JSON.stringify(services) },
        }).catch(error => assert.fail(error.stderr || error.message));
        const result = JSON.parse(stdout);
        assert.match(result.version, /^5\.1\./);
        assert.deepEqual(result.services, services.map(service => ({
          name: service.name, directory: join(root, service.directory), arguments: [service.entry], port: service.port ?? '',
        })));
      });
    }
  }
});
