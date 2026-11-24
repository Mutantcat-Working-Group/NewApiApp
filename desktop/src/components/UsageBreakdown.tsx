import { Card, Col, Empty, Row, Space, Typography } from 'antd';
import type { HourPoint, ModelShare } from '../usage';
import { topModelShares } from '../usage';
import { formatHour, formatNumber } from '../format';

const PALETTE = ['#2f6fed', '#7c5cff', '#0ea5a5', '#f59e0b', '#ef4d7a', '#8b95a7'];

function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

const FULL_CIRCLE = Math.PI * 2;

type DonutProps = {
  slices: Array<{ label: string; value: number; color: string }>;
  size?: number;
  thickness?: number;
};

/** 手绘环图：卡片里只有这一处饼图，引一个图表库不划算。 */
function Donut({ slices, size = 164, thickness = 28 }: DonutProps) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const radius = (size - thickness) / 2;
  const center = size / 2;

  let angle = -Math.PI / 2;
  const arcs = slices.map((slice) => {
    const fraction = total > 0 ? slice.value / total : 0;
    const start = angle;
    const end = angle + fraction * FULL_CIRCLE;
    angle = end;
    return { slice, start, end };
  });

  return (
    <svg width={size} height={size} role="img" aria-label="模型用量占比">
      <circle
        cx={center}
        cy={center}
        r={radius}
        stroke="#e8ebf1"
        strokeWidth={thickness}
        fill="none"
      />
      {arcs.map(({ slice, start, end }) => {
        if (slice.value <= 0 || end - start <= 0) {
          return null;
        }
        // 100% 时弧线首尾重合，svg 会画不出来；收一点让路径闭合。
        const safeEnd = end - start >= FULL_CIRCLE - 0.001 ? end - 0.001 : end;
        const x1 = center + radius * Math.cos(start);
        const y1 = center + radius * Math.sin(start);
        const x2 = center + radius * Math.cos(safeEnd);
        const y2 = center + radius * Math.sin(safeEnd);
        const largeArc = safeEnd - start > Math.PI ? 1 : 0;
        return (
          <path
            key={slice.label}
            d={`M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`}
            stroke={slice.color}
            strokeWidth={thickness}
            fill="none"
          >
            <title>{`${slice.label}：${formatNumber(slice.value)} tokens`}</title>
          </path>
        );
      })}
    </svg>
  );
}

type LineProps = {
  points: HourPoint[];
  height?: number;
  color?: string;
};

/** 极简折线图，坐标用 viewBox 百分比，宽度跟着容器走。 */
function HourLine({ points, height = 170, color = '#2f6fed' }: LineProps) {
  const width = 600;
  const max = Math.max(1, ...points.map((point) => point.tokenUsed));
  const paddingX = 6;
  const step = points.length > 1 ? (width - paddingX * 2) / (points.length - 1) : 0;
  const toX = (index: number) => paddingX + index * step;
  const toY = (value: number) => height - 14 - (value / max) * (height - 26);

  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${toX(index)} ${toY(point.tokenUsed)}`)
    .join(' ');
  const area = points.length
    ? `${path} L ${toX(points.length - 1)} ${height - 6} L ${toX(0)} ${height - 6} Z`
    : '';

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height }}
      role="img"
      aria-label="逐小时 token 用量"
    >
      {[0, 0.5, 1].map((ratio) => (
        <line
          key={ratio}
          x1={0}
          x2={width}
          y1={height - 14 - ratio * (height - 26)}
          y2={height - 14 - ratio * (height - 26)}
          stroke="#e8ebf1"
          strokeWidth={1}
        />
      ))}
      {points.length > 1 ? (
        <>
          <path d={area} fill={color} fillOpacity={0.12} />
          <path
            d={path}
            stroke={color}
            strokeWidth={2}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
          {points.map((point, index) =>
            point.tokenUsed > 0 ? (
              <circle
                key={point.timestamp}
                cx={toX(index)}
                cy={toY(point.tokenUsed)}
                r={2.5}
                fill={color}
                vectorEffect="non-scaling-stroke"
              >
                <title>{`${formatHour(point.timestamp)} · ${formatNumber(point.tokenUsed)} tokens · ${point.count} 次`}</title>
              </circle>
            ) : null,
          )}
        </>
      ) : null}
    </svg>
  );
}

type UsageBreakdownProps = {
  models: ModelShare[];
  hours: HourPoint[];
  /** 站点没有返回用量数据时显示占位，不画空图。 */
  empty: boolean;
};

/** API 令牌上方的「调用分布」：近 24 小时的模型占比与逐小时 token 走势。 */
export default function UsageBreakdown({ models, hours, empty }: UsageBreakdownProps) {
  const shares = topModelShares(models);
  const slices = shares.map((entry, index) => ({
    label: entry.model,
    value: entry.tokenUsed,
    color: colorFor(index),
  }));
  const peak = hours.reduce((best, entry) => (entry.tokenUsed > best.tokenUsed ? entry : best), {
    timestamp: 0,
    tokenUsed: 0,
    count: 0,
  });
  const totalTokens = hours.reduce((sum, entry) => sum + entry.tokenUsed, 0);
  const totalCounts = hours.reduce((sum, entry) => sum + entry.count, 0);
  const ticks = hours.length
    ? [0, Math.floor(hours.length / 2), hours.length - 1].map((index) => hours[index])
    : [];

  return (
    <Card
      title="调用分布"
      extra={<Typography.Text type="secondary">近 24 小时</Typography.Text>}
      className="section-card"
      bordered={false}
      hoverable
    >
      {empty ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="站点未开放用量接口" />
      ) : (
        <Row gutter={[24, 16]} align="middle">
          <Col xs={24} lg={9}>
            <div className="usage-donut">
              <Donut slices={slices} />
              <div className="usage-legend">
                {shares.map((entry, index) => (
                  <div key={entry.model} className="usage-legend-row">
                    <span
                      className="usage-legend-dot"
                      style={{ backgroundColor: colorFor(index) }}
                    />
                    <span className="usage-legend-label" title={entry.model}>
                      {entry.model}
                    </span>
                    <span className="usage-legend-value">{Math.round(entry.share * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </Col>
          <Col xs={24} lg={15}>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <div className="usage-chart-head">
                <Typography.Text strong>逐小时 Token</Typography.Text>
                {peak.tokenUsed > 0 ? (
                  <Typography.Text type="secondary" className="usage-chart-peak">
                    峰值 {formatNumber(peak.tokenUsed)} · {formatHour(peak.timestamp)}
                  </Typography.Text>
                ) : null}
              </div>
              <HourLine points={hours} />
              <div className="usage-axis">
                {ticks.map((tick) => (
                  <span key={tick.timestamp}>{formatHour(tick.timestamp)}</span>
                ))}
              </div>
              <Typography.Text type="secondary" className="usage-footnote">
                合计 {formatNumber(totalTokens)} tokens · {formatNumber(totalCounts)} 次请求
              </Typography.Text>
            </Space>
          </Col>
        </Row>
      )}
    </Card>
  );
}
