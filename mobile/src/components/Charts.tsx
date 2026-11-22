import Svg, { Circle, Path, Rect } from 'react-native-svg';

export type DonutSlice = {
  label: string;
  value: number;
  color: string;
};

type DonutChartProps = {
  slices: DonutSlice[];
  size?: number;
  thickness?: number;
};

const FULL_CIRCLE = Math.PI * 2;

/**
 * 用 svg 弧线画的饼图/环图。不引图表库：本项目只用得到饼图和折线图，
 * react-native-svg 一个原生依赖能同时画两者，比 victory-native 便宜得多。
 */
export default function DonutChart({ slices, size = 132, thickness = 26 }: DonutChartProps) {
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
    <Svg width={size} height={size}>
      <Circle
        cx={center}
        cy={center}
        r={radius}
        stroke="#e6e9f0"
        strokeWidth={thickness}
        fill="none"
      />
      {arcs.map(({ slice, start, end }) => {
        if (slice.value <= 0 || end - start <= 0) {
          return null;
        }
        // 100% 时弧线首尾重合，svg 会画不出来；收 1 度让路径闭合。
        const safeEnd = end - start >= FULL_CIRCLE - 0.001 ? end - 0.001 : end;
        const x1 = center + radius * Math.cos(start);
        const y1 = center + radius * Math.sin(start);
        const x2 = center + radius * Math.cos(safeEnd);
        const y2 = center + radius * Math.sin(safeEnd);
        const largeArc = safeEnd - start > Math.PI ? 1 : 0;
        return (
          <Path
            key={slice.label}
            d={`M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`}
            stroke={slice.color}
            strokeWidth={thickness}
            strokeLinecap="butt"
            fill="none"
          />
        );
      })}
    </Svg>
  );
}

export type LinePoint = {
  label: string;
  value: number;
};

type LineChartProps = {
  points: LinePoint[];
  height?: number;
  color?: string;
};

/** 极简折线图：只画网格和折线，刻度文字由外层用三个时间点标注。 */
export function LineChart({ points, height = 120, color = '#2f6fed' }: LineChartProps) {
  const values = points.map((point) => point.value);
  const max = Math.max(1, ...values);
  const paddingX = 2;
  const step = points.length > 1 ? (100 - paddingX * 2) / (points.length - 1) : 0;
  // 用 viewBox 的百分比坐标，宽度交给容器，不用测量屏幕宽度。
  const toX = (index: number) => paddingX + index * step;
  const toY = (value: number) => height - 4 - (value / max) * (height - 10);

  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${toX(index)} ${toY(point.value)}`)
    .join(' ');
  const area = `${path} L ${toX(points.length - 1)} ${height} L ${toX(0)} ${height} Z`;

  return (
    <Svg width="100%" height={height} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none">
      {[0, 0.5, 1].map((ratio) => (
        <Rect
          key={ratio}
          x={0}
          y={height - 4 - ratio * (height - 10)}
          width={100}
          height={1}
          fill="#e6e9f0"
        />
      ))}
      {points.length > 1 ? (
        <>
          <Path d={area} fill={color} fillOpacity={0.12} />
          <Path
            d={path}
            stroke={color}
            strokeWidth={2}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        </>
      ) : null}
    </Svg>
  );
}
