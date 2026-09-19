import assert from 'node:assert/strict';
import { isIP } from 'node:net';
import { monitorNames } from './monitoring-config.mjs';

export const label = 'bairui.preprod.installation';
export const origin = 'https://localhost:8443';
export const names = Object.freeze({
  stack: 'bairui-preprod', api: 'bairui-preprod_api', db: 'bairui-preprod_db',
  gateway: 'bairui-preprod-gateway', edge: 'bairui-preprod-edge', data: 'bairui-preprod-data',
  volume: 'bairui-preprod-pgdata', caddyVolume: 'bairui-preprod-caddy-data',
  envSecret: 'bairui-preprod-env', adminSecret: 'bairui-preprod-db-admin', appSecret: 'bairui-preprod-db-app',
});
export const apiImage = revision => 'bairui/platform-api-preprod:' + revision;
export const webImage = revision => 'bairui/platform-web-preprod:' + revision;
export const bootstrapName = hash => 'bairui-preprod-bootstrap-' + hash.slice(0, 16);

export function dockerEndpoint(env, contextEndpoint) {
  return env.DOCKER_CONTEXT ? contextEndpoint : env.DOCKER_HOST || contextEndpoint;
}

export function missingDockerObject(stderr) {
  return /no such (object|container|service|network|volume|secret|config|image)\b/i.test(stderr)
    || /\b(container|service|network|volume|secret|config|image) \S+ not found\b/i.test(stderr);
}

export function assertOwned(labels, installation) {
  assert.match(installation, /^[a-f0-9]{24}$/, 'invalid_installation');
  assert.equal(labels?.[label], installation, 'resource_not_owned_by_this_installation');
}

export function assertLocalDocker(info, endpoint) {
  assert.ok(/^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_-]+$/.test(endpoint) || /^unix:\/\/\//.test(endpoint), 'local_docker_endpoint_required');
  assert.equal(info.OSType, 'linux', 'linux_containers_required');
  assert.equal(info.Swarm?.LocalNodeState, 'active', 'active_swarm_required');
  assert.equal(info.Swarm?.ControlAvailable, true, 'swarm_manager_required');
  assert.equal(info.Swarm?.Nodes, 1, 'single_node_only');
}

export function stackConfig({ installation, nodeId, proxyIp, revision, schemaHash, monitoring }) {
  assert.match(installation, /^[a-f0-9]{24}$/);
  assert.match(nodeId, /^[a-z0-9-]+$/);
  assert.match(revision, /^[a-f0-9]{16}$/);
  assert.match(schemaHash, /^[a-f0-9]{64}$/);
  assert.ok(isIP(proxyIp) === 4 && !/^(0|127|169|224|255)\./.test(proxyIp), 'exact_overlay_proxy_ip_required');
  const labels = { [label]: installation };
  const logging = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } };
  const placement = { constraints: ['node.id == ' + nodeId] };
  return {
    version: '3.8',
    services: {
      api: {
        image: apiImage(revision), user: '1000:1000', read_only: true, cap_drop: ['ALL'],
        labels, logging, networks: ['edge', 'data', ...(monitoring?.enabled ? ['monitor'] : [])], stop_grace_period: '20s',
        environment: {
          NODE_ENV: 'production', PORT: '8080', BAIRUI_PLATFORM_MODE: 'platform', BAIRUI_AUTH_MODE: 'better-auth',
          BAIRUI_SECRET_FILE: '/run/secrets/platform-env', BETTER_AUTH_URL: origin,
          BAIRUI_TRUSTED_PROXIES: proxyIp + '/32', BAIRUI_SIMULATION_ENABLED: '0',
          BAIRUI_DB_POOL_MAX: '10', BAIRUI_DB_CONNECT_TIMEOUT_MS: '2000', BAIRUI_DB_QUERY_TIMEOUT_MS: '5000',
          ...(monitoring?.enabled ? { BAIRUI_METRICS_ENABLED: '1', BAIRUI_METRICS_PORT: '9464', BAIRUI_METRICS_TOKEN_FILE: '/run/secrets/metrics-token' } : {}),
        },
        secrets: [{ source: 'platform_env', target: 'platform-env', uid: '1000', gid: '1000', mode: 256 },
          ...(monitoring?.enabled ? [{ source: 'metrics_token', target: 'metrics-token', uid: '1000', gid: '1000', mode: 256 }] : [])],
        healthcheck: {
          test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:8080/livez',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
          interval: '10s', timeout: '3s', retries: 3, start_period: '20s',
        },
        deploy: {
          replicas: 2, labels, placement,
          resources: { limits: { cpus: '0.75', memory: '384M' }, reservations: { cpus: '0.10', memory: '128M' } },
          restart_policy: { condition: 'any', delay: '3s' },
          update_config: { parallelism: 1, delay: '3s', order: 'start-first', monitor: '20s', failure_action: 'rollback' },
          rollback_config: { parallelism: 1, order: 'stop-first', monitor: '20s', failure_action: 'pause' },
        },
      },
      db: {
        image: 'pgvector/pgvector:0.8.2-pg17-bookworm', labels, logging, networks: ['data'], stop_grace_period: '30s',
        environment: { POSTGRES_DB: 'bairui_preprod', POSTGRES_USER: 'postgres', POSTGRES_PASSWORD_FILE: '/run/secrets/db-admin' },
        volumes: ['pgdata:/var/lib/postgresql/data'],
        secrets: [{ source: 'db_admin', target: 'db-admin' }, { source: 'db_app', target: 'app-password' }],
        configs: [{ source: 'bootstrap', target: '/docker-entrypoint-initdb.d/010-platform.sql' }],
        healthcheck: {
          test: ['CMD-SHELL', `psql -U postgres -d bairui_preprod -tAc "SELECT 1 FROM platform_ops.bootstrap WHERE schema_hash = '${schemaHash}'" | grep -qx 1`],
          interval: '10s', timeout: '5s', retries: 5, start_period: '60s',
        },
        deploy: {
          replicas: 1, labels, placement,
          resources: { limits: { cpus: '1.0', memory: '1G' }, reservations: { cpus: '0.25', memory: '256M' } },
          restart_policy: { condition: 'any', delay: '5s' },
          update_config: { parallelism: 1, order: 'stop-first', monitor: '30s', failure_action: 'pause' },
        },
      },
    },
    networks: { edge: { external: { name: names.edge } }, data: { external: { name: names.data } },
      ...(monitoring?.enabled ? { monitor: { external: { name: monitorNames.network } } } : {}) },
    volumes: { pgdata: { external: { name: names.volume } } },
    secrets: {
      platform_env: { external: { name: names.envSecret } }, db_admin: { external: { name: names.adminSecret } },
      db_app: { external: { name: names.appSecret } },
      ...(monitoring?.enabled ? { metrics_token: { external: { name: monitorNames.metricsSecret } } } : {}),
    },
    configs: { bootstrap: { external: { name: bootstrapName(schemaHash) } } },
  };
}

export function gatewayConfig({ monitoring } = {}) {
  return `{
  admin off
  auto_https disable_redirects
  skip_install_trust
  servers {
    timeouts {
      read_header 10s
      read_body 30s
      write 35s
      idle 1m
    }
  }
}
https://localhost {
  tls internal
  encode gzip
  header {
    X-Content-Type-Options nosniff
    Referrer-Policy same-origin
    -Server
  }
  @private path /metrics /metrics/* /prometheus /prometheus/* /alertmanager /alertmanager/* /alerts /alerts/* /-/ready /-/healthy
  handle @private {
    respond 404
  }
  @api path /api /api/* /healthz /readyz /livez
  handle @api {
    header Cache-Control "no-store"
    reverse_proxy {
      dynamic a {
        name tasks.${names.api}
        port 8080
        refresh 2s
      }
      lb_policy round_robin
      lb_try_duration 2s
      fail_duration 5s
      max_fails 1
      unhealthy_status 502 503 504
      header_up -X-Bairui-Peer-Ip
      transport http {
        dial_timeout 2s
        response_header_timeout 20s
      }
    }
  }
  handle {
    root * /srv
    @assets path /assets/*
    handle @assets {
      header Cache-Control "public, max-age=31536000, immutable"
      file_server
    }
    handle {
      header Cache-Control "no-store"
      try_files {path} /index.html
      file_server
    }
  }
}
${monitoring?.enabled ? `https://localhost:9443 {
  tls internal
  @private path /metrics /metrics/*
  handle @private {
    respond 404
  }
  header {
    X-Content-Type-Options nosniff
    Referrer-Policy same-origin
    -Server
  }
  handle {
    reverse_proxy ${monitorNames.grafana}:3000 {
      transport http {
        dial_timeout 2s
        response_header_timeout 20s
      }
    }
  }
}` : ''}
`;
}

export function bootstrapSql(migrations, schemaHash) {
  assert.match(schemaHash, /^[a-f0-9]{64}$/);
  return `\\set ON_ERROR_STOP on
\\connect bairui_preprod
${migrations.map(({ name, sql }) => '-- ' + name + '\n' + sql).join('\n')}
\\set app_password \`cat /run/secrets/app-password\`
CREATE ROLE bairui_preprod_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'app_password';
REVOKE ALL ON DATABASE bairui_preprod FROM PUBLIC;
GRANT CONNECT ON DATABASE bairui_preprod TO bairui_preprod_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO bairui_preprod_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bairui_preprod_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bairui_preprod_app;
ALTER ROLE bairui_preprod_app SET statement_timeout = '10s';
ALTER ROLE bairui_preprod_app SET lock_timeout = '3s';
ALTER ROLE bairui_preprod_app SET idle_in_transaction_session_timeout = '15s';
CREATE SCHEMA platform_ops;
REVOKE ALL ON SCHEMA platform_ops FROM PUBLIC;
CREATE TABLE platform_ops.bootstrap (schema_hash text PRIMARY KEY, installed_at timestamptz NOT NULL DEFAULT now());
INSERT INTO platform_ops.bootstrap (schema_hash) VALUES ('${schemaHash}');
`;
}
