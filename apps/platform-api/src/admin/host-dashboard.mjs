// Provisioning and the authenticated gateway share these exact expressions.
const selector = '{job="bairui-host"}';
const sample = 'bairui_host_metrics_sample_timestamp_seconds' + selector;
const age = '(time() - ' + sample + ')';
const live = ' and on(instance) (up' + selector + ' == 1)'
  + ' and on(instance) (' + age + ' >= 0) and on(instance) (' + age + ' <= 45)';
const metric = name => name + selector;
const rate = name => 'rate(' + metric(name) + '[1m])';
const fresh = expr => '(' + expr + ')' + live;

const definitions = [
  ['主机采集端可达 / 1 可达、0 失败', 'up' + selector, 'short', 'stat'],
  ['最近成功样本时间', sample + ' * 1000', 'dateTimeAsIso', 'stat'],
  ['最近成功样本距今 / 秒', age, 's', 'stat'],
  ['Linux 主机运行时长', fresh('time() - ' + metric('node_boot_time_seconds')), 's', 'stat'],
  ['主机 CPU 实际使用率 / 最近 1 分钟', fresh('1 - avg by(instance) (rate(node_cpu_seconds_total{job="bairui-host",mode="idle"}[1m]))'), 'percentunit'],
  ['主机已用内存', fresh(metric('node_memory_MemTotal_bytes') + ' - ' + metric('node_memory_MemAvailable_bytes')), 'bytes'],
  ['主机可用内存', fresh(metric('node_memory_MemAvailable_bytes')), 'bytes'],
  ['主机总内存', fresh(metric('node_memory_MemTotal_bytes')), 'bytes', 'stat'],
  ['主机已用 Swap / 未配置时为 0', fresh(metric('node_memory_SwapTotal_bytes') + ' - ' + metric('node_memory_SwapFree_bytes')), 'bytes'],
  ['主机 Swap 总量 / 未配置时为 0', fresh(metric('node_memory_SwapTotal_bytes')), 'bytes', 'stat'],
  ['文件系统总容量 / 挂载点', fresh(metric('node_filesystem_size_bytes')), 'bytes', 'timeseries', '{{instance}} {{mountpoint}} {{device}} {{fstype}}'],
  ['文件系统可用容量 / 挂载点', fresh(metric('node_filesystem_avail_bytes')), 'bytes', 'timeseries', '{{instance}} {{mountpoint}} {{device}} {{fstype}}'],
  ['文件系统已用比例 / 挂载点', fresh('(1 - ' + metric('node_filesystem_avail_bytes') + ' / ' + metric('node_filesystem_size_bytes') + ') and (' + metric('node_filesystem_size_bytes') + ' > 0)'), 'percentunit', 'timeseries', '{{instance}} {{mountpoint}} {{device}} {{fstype}}'],
  ['文件系统 inode 已用比例 / 挂载点', fresh('(1 - ' + metric('node_filesystem_files_free') + ' / ' + metric('node_filesystem_files') + ') and (' + metric('node_filesystem_files') + ' > 0)'), 'percentunit', 'timeseries', '{{instance}} {{mountpoint}} {{device}} {{fstype}}'],
  ['磁盘读取速率 / 设备 / 最近 1 分钟', fresh(rate('node_disk_read_bytes_total')), 'Bps', 'timeseries', '{{instance}} {{device}}'],
  ['磁盘写入速率 / 设备 / 最近 1 分钟', fresh(rate('node_disk_written_bytes_total')), 'Bps', 'timeseries', '{{instance}} {{device}}'],
  ['网络接收速率 / 网卡 / 最近 1 分钟', fresh(rate('node_network_receive_bytes_total')), 'Bps', 'timeseries', '{{instance}} {{device}}'],
  ['网络发送速率 / 网卡 / 最近 1 分钟', fresh(rate('node_network_transmit_bytes_total')), 'Bps', 'timeseries', '{{instance}} {{device}}'],
  ['网络累计接收 / 网卡计数 / 自启动或重置以来', fresh(metric('node_network_receive_bytes_total')), 'bytes', 'timeseries', '{{instance}} {{device}}'],
  ['网络累计发送 / 网卡计数 / 自启动或重置以来', fresh(metric('node_network_transmit_bytes_total')), 'bytes', 'timeseries', '{{instance}} {{device}}'],
  ['网络接收错误 / 秒 / 最近 1 分钟', fresh(rate('node_network_receive_errs_total')), 'ops', 'timeseries', '{{instance}} {{device}}'],
  ['网络发送错误 / 秒 / 最近 1 分钟', fresh(rate('node_network_transmit_errs_total')), 'ops', 'timeseries', '{{instance}} {{device}}'],
  ['网络接收丢包 / 秒 / 最近 1 分钟', fresh(rate('node_network_receive_drop_total')), 'pps', 'timeseries', '{{instance}} {{device}}'],
  ['网络发送丢包 / 秒 / 最近 1 分钟', fresh(rate('node_network_transmit_drop_total')), 'pps', 'timeseries', '{{instance}} {{device}}'],
];

export const hostDashboardExpressions = Object.freeze(definitions.map(([, expr]) => expr));

export function hostDashboard() {
  const datasource = { type: 'prometheus', uid: 'bairui-prometheus' };
  return {
    uid: 'bairui-host', title: 'BaiRui 主机资源', tags: ['bairui', 'host'], schemaVersion: 39, version: 1, editable: false,
    description: '本批采集实际原生 Linux 宿主机；Docker Desktop 的 Linux VM 不等于 Windows 宿主机，部署入口拒绝该环境。采集端可达仅表示抓取成功；成功样本超过 45 秒或时间在未来时不显示实时资源。速率取最近 1 分钟；网卡计数自启动或重置以来累计。',
    timezone: 'browser', refresh: '15s', time: { from: 'now-30m', to: 'now' }, templating: { list: [] },
    panels: definitions.map(([title, expr, unit, type = 'timeseries', legendFormat = '{{instance}}'], index) => ({
      id: index + 1, title, type, datasource,
      gridPos: { h: 8, w: 12, x: index % 2 * 12, y: Math.floor(index / 2) * 8 },
      targets: [{ refId: 'A', expr, legendFormat, ...(type === 'stat' ? { instant: true, range: false } : {}) }],
      fieldConfig: { defaults: { unit, noValue: '未采集 / 不可用', decimals: 2, color: { mode: 'palette-classic' } }, overrides: [] },
      options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
    })),
  };
}
