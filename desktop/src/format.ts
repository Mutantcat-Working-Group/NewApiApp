/**
 * 看板上的数字格式化。窄卡片放不下七八位数，所以超过一万就折成 k / M。
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '-';
  }
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(value) >= 10_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return value.toLocaleString('zh-CN');
}

/** 图表坐标轴用的短标签：只要小时。 */
export function formatHour(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return `${String(date.getHours()).padStart(2, '0')}:00`;
}
