import { useResizeObserver } from "@humansignal/core/hooks/useResizeObserver";
import { type FC, useContext, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../../../utils/bem";
import { isDefined } from "../../../../utils/utilities";
import { TimelineContext } from "../../Context";
import { visualizeLifespans } from "./Utils";
import "./Minimap.prefix.css";

// Visual constants - kept in sync with Minimap.prefix.css
const MAX_MINIMAP_REGIONS = 20;
const MIN_HEIGHT_PX = 40;
const MAX_HEIGHT_PX = 160;
const ROW_HEIGHT_PX = 6; // 4px height + 2px row gap/padding
const HEADER_RESERVED_PX = 16;

export interface MinimapProps {
  /** Maximum number of regions to render. Defaults to 20. */
  maxRegions?: number;
}

export const Minimap: FC<MinimapProps> = ({ maxRegions = MAX_MINIMAP_REGIONS }) => {
  const { regions, length } = useContext(TimelineContext);
  const root = useRef<HTMLDivElement>();
  const [step, setStep] = useState(0);

  const visibleRegions = regions.slice(0, maxRegions);
  const hasOverflow = regions.length > maxRegions;

  const visualization = useMemo(() => {
    return visibleRegions.map(({ id, color, label, sequence, locked }) => {
      return {
        id,
        color,
        label,
        lifespans: visualizeLifespans(sequence, step, locked),
      };
    });
  }, [step, regions, maxRegions]);

  // Detect overlap zones across all regions: frames where 2+ regions are active
  const overlaps = useMemo(() => {
    if (!length) return [] as { start: number; width: number; depth: number }[];

    const counts = new Int16Array(length + 1);
    for (const r of visualization) {
      for (let i = 0; i < r.lifespans.length; i++) {
        const span = r.lifespans[i];
        const startFrame = span.start;
        const endFrame = startFrame + span.length;
        if (span.enabled) {
          for (let f = startFrame; f <= endFrame && f < counts.length; f++) {
            counts[f] += 1;
          }
        }
        if (span.length === 0) counts[startFrame] += 1;
      }
    }

    const result: { start: number; width: number; depth: number }[] = [];
    let segStart = -1;
    let segDepth = 0;
    for (let f = 0; f < counts.length; f++) {
      if (counts[f] >= 2) {
        if (segStart < 0) {
          segStart = f;
          segDepth = counts[f];
        } else {
          segDepth = Math.max(segDepth, counts[f]);
        }
      } else if (segStart >= 0) {
        result.push({ start: segStart * step, width: (f - segStart) * step, depth: segDepth });
        segStart = -1;
      }
    }
    if (segStart >= 0) {
      result.push({ start: segStart * step, width: (counts.length - segStart) * step, depth: segDepth });
    }
    return result;
  }, [visualization, length, step]);

  const { width: rootWidth = 0 } = useResizeObserver(root.current || []);
  useEffect(() => {
    if (isDefined(root.current) && length > 0) {
      setStep(rootWidth / length);
    }
  }, [length, rootWidth]);

  // Dynamic height: shrink for few rows, grow up to max for many; scroll above that
  const targetHeight = Math.min(
    MAX_HEIGHT_PX,
    Math.max(MIN_HEIGHT_PX, visibleRegions.length * ROW_HEIGHT_PX + HEADER_RESERVED_PX),
  );

  return (
    <div
      ref={root as any}
      className={cn("minimap").toClassName()}
      style={{ height: targetHeight, overflowY: hasOverflow ? "auto" : "hidden" }}
    >
      <div className={cn("minimap").elem("backdrop").toClassName()} aria-hidden />

      {visualization.map(({ id, color, label, lifespans }) => {
        return (
          <div
            key={id}
            className={cn("minimap").elem("region").toClassName()}
            style={{ "--color": color } as any}
            title={label}
          >
            <span className={cn("minimap").elem("label").toClassName()}>{label}</span>
            {lifespans.map((connection, i) => {
              const isLast = i + 1 === lifespans.length;
              const left = connection.start * step;
              const width = isLast && connection.enabled ? "100%" : connection.width;

              return (
                <div
                  key={`${id}${i}`}
                  className={cn("minimap").elem("connection").toClassName()}
                  style={{ left, width }}
                />
              );
            })}
          </div>
        );
      })}

      {overlaps.length > 0 && (
        <div className={cn("minimap").elem("overlap-layer").toClassName()} aria-hidden>
          {overlaps.map((o, i) => (
            <div
              key={`ov-${i}`}
              className={cn("minimap").elem("overlap").toClassName()}
              style={{ left: o.start, width: o.width, opacity: Math.min(0.15 + o.depth * 0.1, 0.55) }}
              title={`${o.depth} overlapping regions`}
            />
          ))}
        </div>
      )}

      {hasOverflow && (
        <div className={cn("minimap").elem("overflow-badge").toClassName()} aria-hidden>
          +{regions.length - maxRegions} more
        </div>
      )}
    </div>
  );
};
