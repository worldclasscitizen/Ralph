import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  getNodesBounds,
  useReactFlow,
  useStore,
  useViewport,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type ELKType from "elkjs/lib/elk.bundled.js";
import type { Explain } from "./explanations";
import {
  Elapsed,
  Icon,
  modelLabel,
  nodeTitle,
  statusLabel,
  statusTone,
  TaskIcon,
  type Row,
} from "./presentation";

declare const ELK: typeof ELKType;
const elk = new ELK();
const cardWidth = 154;
const cardHeight = 68;
const minZoom = 0.06;
const maxZoom = 2;

function Card({ data }: NodeProps) {
  const task = data as Row;
  const tone = statusTone(task.status);
  const title = nodeTitle(task);
  return (
    <div
      className="node"
      data-tone={tone}
      data-inspected={task.inspected}
      role="button"
      tabIndex={0}
      aria-label={`Inspect ${task.nodeId}`}
      title={title}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        task.onInspect(task.nodeId);
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="node-label">
        <TaskIcon task={task} />
        <strong>{task.easyTitle || title}</strong>
        <small>{modelLabel(task)}</small>
      </div>
      <div className="node-state">
        {statusLabel(task.status)}
        <Elapsed
          startedAt={task.startedAt}
          endedAt={task.endedAt}
          active={tone === "active"}
        />
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function Dependency({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps) {
  const live = data?.live === true;
  const packet = useRef<SVGGElement>(null);
  const [finishPacket, setFinishPacket] = useState(live);
  useEffect(() => {
    if (live) {
      setFinishPacket(true);
      return;
    }
    const animation = packet.current?.getAnimations()[0];
    const effect = animation?.effect;
    const duration = effect?.getComputedTiming().duration;
    if (!animation || !effect || typeof duration !== "number" || duration <= 0) {
      setFinishPacket(false);
      return;
    }

    const current = Number(animation.currentTime) || 0;
    effect.updateTiming({ iterations: Math.floor(current / duration) + 1 });
    let stillStopping = true;
    const finish = () => {
      if (stillStopping) setFinishPacket(false);
    };
    void animation.finished.then(finish, finish);
    return () => {
      stillStopping = false;
      effect.updateTiming({ iterations: Infinity });
    };
  }, [live]);

  const mid = (sourceX + targetX) / 2;
  const path = `M${sourceX},${sourceY} C${mid},${sourceY} ${mid},${targetY} ${targetX},${targetY}`;
  return (
    <g className="dependency" data-tone={data?.tone}>
      <BaseEdge id={id} path={path} />
      {(live || finishPacket) && (
        <g
          className="data-packet"
          aria-hidden="true"
          ref={packet}
          style={{ offsetPath: `path("${path}")` }}
        >
          <circle className="packet-halo" r="7" />
          <circle r="3" />
        </g>
      )}
    </g>
  );
}
const nodeTypes = { task: Card };
const edgeTypes = { dependency: Dependency };

function graphPadding(width: number) {
  const wide = Math.max(0, Math.min(1, (width - 822) / (1204 - 822)));
  return { left: 22 + wide * 48, right: 70 + wide * 139, wide };
}

function GraphControls({
  count,
  bounds,
  moved,
  onFit,
  inspecting,
}: {
  count: number;
  bounds?: { x: number; y: number; width: number; height: number };
  onFit: () => void;
  inspecting: boolean;
  moved: { current: boolean };
}) {
  const flow = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const { zoom } = useViewport();
  const overview = zoom < 0.65;
  function fit(duration = 0) {
    if (!flow.viewportInitialized || !bounds || !width || !height) return;
    const { left, right } = graphPadding(width);
    const availableWidth = Math.max(1, width - left - right);
    const availableHeight = Math.max(1, height - 88);
    const zoom = Math.max(
      minZoom,
      Math.min(
        1,
        availableWidth / bounds.width,
        availableHeight / bounds.height,
      ),
    );
    void flow.setViewport(
      {
        x: left + (availableWidth - bounds.width * zoom) / 2 - bounds.x * zoom,
        y: (height - bounds.height * zoom) / 2 - bounds.y * zoom - 2,
        zoom,
      },
      { duration },
    );
  }
  useEffect(() => {
    if (!moved.current) fit();
  }, [bounds, width, height, flow.viewportInitialized]);

  return (
    <>
      <div className="canvas-label">
        <strong>실행 그래프</strong>
        {overview ? (
          <small>전체 보기 · 노드 {count}개</small>
        ) : (
          !inspecting && <small>노드를 선택해 작업을 확인하세요.</small>
        )}
      </div>
      <div className={`graph-tools ${overview ? "with-map" : ""}`}>
        <div className="zoom-controls" role="group" aria-label="그래프 크기">
          <button
            type="button"
            title="축소"
            aria-label="축소"
            disabled={zoom <= minZoom}
            onClick={() => {
              moved.current = true;
              void flow.zoomOut({ duration: 160 });
            }}
          >
            <Icon name="minus" />
          </button>
          <span className="zoom-value" aria-label="확대 비율">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            title="확대"
            aria-label="확대"
            disabled={zoom >= maxZoom}
            onClick={() => {
              moved.current = true;
              void flow.zoomIn({ duration: 160 });
            }}
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            title="전체 맞춤"
            aria-label="전체 맞춤"
            onClick={() => {
              moved.current = false;
              onFit();
              fit(180);
            }}
          >
            <Icon name="fit" />
          </button>
        </div>
        {overview && (
          <div
            className="map-preview"
            onPointerDown={() => {
              moved.current = true;
            }}
          >
            <span>전체 그래프</span>
            <MiniMap
              pannable
              bgColor="transparent"
              nodeStrokeWidth={0}
              maskColor="var(--map-mask)"
              maskStrokeColor="var(--wait)"
              maskStrokeWidth={1}
              nodeColor={(node) =>
                `var(--${statusTone(node.data.status as string)}-border)`
              }
              ariaLabel="전체 그래프 지도"
            />
          </div>
        )}
      </div>
    </>
  );
}

export function RunGraph({
  graph,
  run,
  explain,
  inspected,
  onInspect,
  onClose,
}: {
  graph?: Row;
  run?: Row;
  explain: Explain;
  inspected: string;
  onInspect: (id: string) => void;
  onClose: () => void;
}) {
  const [layout, setLayout] = useState<{
    graph: Row;
    positions: Record<string, { x: number; y: number }>;
  }>();
  const [layoutError, setLayoutError] = useState<Row>();
  const [compact, setCompact] = useState(false);
  const [layoutWidth, setLayoutWidth] = useState(822);
  const canvas = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (!moved.current && entry.contentRect.width > 0)
        setLayoutWidth(entry.contentRect.width);
    });
    if (canvas.current) observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!graph?.nodes.length) return;
    let current = true;
    moved.current = false;
    elk
      .layout({
        id: "root",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "RIGHT",
          "elk.spacing.nodeNode": "46",
          "elk.layered.spacing.nodeNodeBetweenLayers": "38",
          "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
          "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
          "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
        },
        children: graph.nodes.map((node: Row) => ({
          id: node.nodeId,
          width: cardWidth,
          height: cardHeight,
        })),
        edges: graph.edges.map((edge: Row, index: number) => ({
          id: `e${index}`,
          sources: [edge.from],
          targets: [edge.to],
        })),
      })
      .then((result) => {
        if (!current) return;
        setLayout({
          graph,
          positions: Object.fromEntries(
            (result.children ?? []).map((child) => [
              child.id,
              { x: child.x ?? 0, y: child.y ?? 0 },
            ]),
          ),
        });
      })
      .catch(() => {
        if (current) setLayoutError(graph);
      });
    return () => {
      current = false;
    };
  }, [graph]);

  const displayedGraph = layout?.graph.runId === graph?.runId
    ? layout?.graph
    : undefined;
  const positioned = useMemo<Node[]>(() => {
    if (!layout || !displayedGraph) return [];
    const { wide } = graphPadding(layoutWidth);
    const columns = [
      ...new Set(Object.values(layout.positions).map((point) => point.x)),
    ].sort((a, b) => a - b);
    const stretchPerLayer = wide * 65;
    return displayedGraph.nodes.map((task: Row) => {
      const { x, y } = layout.positions[task.nodeId];
      return {
        id: task.nodeId,
        type: "task",
        position: { x: x + columns.indexOf(x) * stretchPerLayer, y },
        width: cardWidth,
        height: cardHeight,
        // Preserve the measured handles when a status update replaces the node data.
        measured: { width: cardWidth, height: cardHeight },
        data: task,
      };
    });
  }, [displayedGraph, layout, layoutWidth]);
  const bounds = useMemo(
    () => (positioned.length ? getNodesBounds(positioned) : undefined),
    [positioned],
  );
  const nodes = useMemo(
    () =>
      positioned.map((task) => ({
        ...task,
        data: {
          ...task.data,
          ...run?.nodes?.[task.id],
          easyTitle: explain("title", task.data.goal as string | undefined),
          inspected: inspected === task.id,
          onInspect,
        },
      })),
    [positioned, run, explain, inspected, onInspect],
  );
  const edges = useMemo(
    () =>
      (displayedGraph?.edges ?? []).map((edge: Row) => {
        const from = statusTone(run?.nodes?.[edge.from]?.status);
        const to = statusTone(run?.nodes?.[edge.to]?.status);
        return {
          id: `${displayedGraph?.runId}:${edge.from}:${edge.kind}:${edge.to}`,
          source: edge.from,
          target: edge.to,
          type: "dependency",
          data: { tone: to, live: from === "done" && to === "active" },
        };
      }),
    [displayedGraph, run],
  );

  return (
    <div className="canvas" data-compact={compact} ref={canvas}>
      {graph?.nodes.length ? (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          onNodeClick={(_, node) => onInspect(node.id)}
          onPaneClick={onClose}
          onMove={(event, viewport) => {
            if (event) moved.current = true;
            setCompact(viewport.zoom < 0.65);
          }}
          minZoom={minZoom}
          maxZoom={maxZoom}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Lines}
            gap={28}
            size={0.6}
            lineWidth={0.6}
            offset={14}
            color="var(--grid)"
          />
          <GraphControls
            count={graph.nodes.length}
            bounds={bounds}
            moved={moved}
            inspecting={Boolean(inspected)}
            onFit={() => {
              if (canvas.current?.clientWidth)
                setLayoutWidth(canvas.current.clientWidth);
            }}
          />
          {layoutError === graph && (
            <p className="empty">실행 그래프를 배치하지 못했습니다.</p>
          )}
        </ReactFlow>
      ) : (
        <>
          <div className="canvas-label">
            <strong>실행 그래프</strong>
          </div>
          <div className="empty">현재 작업 중이 아닙니다</div>
        </>
      )}
    </div>
  );
}
