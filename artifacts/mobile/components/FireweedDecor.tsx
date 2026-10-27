import React from "react";
import Svg, { Circle, Defs, Ellipse, G, LinearGradient, Path, Rect, Stop } from "react-native-svg";

const FADE_COLOR = "#0F1B2D";

const STEM_COLOR = "#4A7C4E";
const FLOWER_COLOR = "#AB47BC";

function Stalk({ height, bend }: { height: number; bend: number }) {
  const stemTop = -height;
  const spikeBase = -height * 0.7;
  const amp = bend * height * 0.05;
  const curveX = (yRel: number) => amp * Math.sin(yRel * Math.PI);

  const cx = amp * 1.6;
  const cy = stemTop * 0.5;
  const stemPath = `M 0 2 Q ${cx} ${cy} 0 ${stemTop}`;

  const flowers: React.ReactNode[] = [];
  const segments = Math.max(10, Math.round((height * 0.3) / 2.6));
  for (let i = 0; i < segments; i++) {
    const t = i / Math.max(segments - 1, 1);
    const y = spikeBase + (stemTop - spikeBase) * t;
    const dx = curveX(-y / height);
    const radius = 3.6 * (1 - t * 0.78);
    flowers.push(<Circle key={`f${i}`} cx={dx} cy={y} r={radius} fill={FLOWER_COLOR} />);
    if (t < 0.7) {
      const sideOffset = 2.4 * (1 - t);
      flowers.push(
        <Circle key={`fl${i}`} cx={dx - sideOffset} cy={y + 1} r={radius * 0.7} fill={FLOWER_COLOR} opacity={0.85} />,
        <Circle key={`fr${i}`} cx={dx + sideOffset} cy={y - 1} r={radius * 0.7} fill={FLOWER_COLOR} opacity={0.85} />,
      );
    }
  }
  const tipDx = curveX(-stemTop / height);
  flowers.push(<Circle key="tip1" cx={tipDx} cy={stemTop - 3} r={1.4} fill={FLOWER_COLOR} opacity={0.7} />);
  flowers.push(<Circle key="tip2" cx={tipDx} cy={stemTop - 7} r={0.9} fill={FLOWER_COLOR} opacity={0.5} />);

  const leaves: React.ReactNode[] = [];
  const leafZone = -height * 0.7;
  const leafCount = Math.floor(height / 16);
  for (let i = 1; i <= leafCount; i++) {
    const t = i / leafCount;
    const y = t * leafZone;
    const dx = curveX(-y / height);
    const side = i % 2 === 0 ? 1 : -1;
    const len = 9 + (1 - t) * 4;
    const ex = dx + side * 6;
    leaves.push(
      <Ellipse
        key={`l${i}`}
        cx={ex}
        cy={y}
        rx={len}
        ry={1.7}
        fill={STEM_COLOR}
        transform={`rotate(${side * -24} ${ex} ${y})`}
      />,
    );
  }

  return (
    <G>
      <Path d={stemPath} stroke={STEM_COLOR} strokeWidth={2.2} strokeLinecap="round" fill="none" />
      {leaves}
      {flowers}
    </G>
  );
}

type Props = { width: number; height?: number };

const STALKS = [
  { x: -0.02, h: 760, op: 0.5, bend: 1 },
  { x: 0.08, h: 880, op: 0.55, bend: 1 },
];

export default function FireweedDecor({ width, height = 360 }: Props) {
  const fadeStart = height * 0.45;
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Defs>
        <LinearGradient id="fwFade" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={FADE_COLOR} stopOpacity="0" />
          <Stop offset="0.55" stopColor={FADE_COLOR} stopOpacity="0.65" />
          <Stop offset="1" stopColor={FADE_COLOR} stopOpacity="1" />
        </LinearGradient>
      </Defs>
      <G transform={`translate(0, ${height})`}>
        {STALKS.map((s, i) => (
          <G key={i} transform={`translate(${s.x * width}, 0)`} opacity={s.op}>
            <Stalk height={s.h} bend={s.bend} />
          </G>
        ))}
      </G>
      <Rect x={0} y={fadeStart} width={width} height={height - fadeStart} fill="url(#fwFade)" />
    </Svg>
  );
}
