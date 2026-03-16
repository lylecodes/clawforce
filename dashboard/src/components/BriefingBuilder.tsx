import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";

type BriefingBuilderProps = {
  active: string[];
  available: string[];
  onChange: (active: string[]) => void;
};

const ALL_BRIEFING_SOURCES = [
  "task_board",
  "activity",
  "cost_summary",
  "team_status",
  "proposals",
  "initiative_status",
  "escalations",
  "team_performance",
  "knowledge",
  "tools_reference",
];

export function BriefingBuilder({
  active,
  available,
  onChange,
}: BriefingBuilderProps) {
  const [draggedItem, setDraggedItem] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Click-to-toggle: move chip between active/available on click
  const handleChipClick = (id: string) => {
    const safeActiveNow = active.map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null && "source" in (item as Record<string, unknown>)) {
        return String((item as Record<string, unknown>).source);
      }
      return String(item);
    });
    if (safeActiveNow.includes(id)) {
      onChange(safeActiveNow.filter((s) => s !== id));
    } else {
      onChange([...safeActiveNow, id]);
    }
  };

  // Defensive: ensure active items are strings (API may return ContextSource objects)
  const safeActive = active.map((item) => {
    if (typeof item === "string") return item;
    if (typeof item === "object" && item !== null && "source" in (item as Record<string, unknown>)) {
      return String((item as Record<string, unknown>).source);
    }
    return String(item);
  });

  // Compute available items that aren't active
  const availableItems = (
    available.length > 0
      ? available
      : ALL_BRIEFING_SOURCES
  ).filter((s) => !safeActive.includes(s));

  const handleDragStart = (event: DragStartEvent) => {
    setDraggedItem(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggedItem(null);
    const { active: dragActive, over } = event;
    if (!over) return;

    const itemId = dragActive.id as string;
    const targetZone = over.id as string;

    if (targetZone === "active-zone" && !safeActive.includes(itemId)) {
      onChange([...safeActive, itemId]);
    } else if (targetZone === "available-zone" && safeActive.includes(itemId)) {
      onChange(safeActive.filter((s) => s !== itemId));
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="space-y-3">
        {/* Active zone */}
        <DroppableZone id="active-zone" label="Active Briefing Sources">
          {safeActive.length === 0 ? (
            <p className="text-xxs text-cf-text-muted p-2">
              Drag sources here to activate
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {safeActive.map((source) => (
                <DraggableChip key={source} id={source} variant="active" onClick={handleChipClick} />
              ))}
            </div>
          )}
        </DroppableZone>

        {/* Available zone */}
        <DroppableZone id="available-zone" label="Available Sources">
          {availableItems.length === 0 ? (
            <p className="text-xxs text-cf-text-muted p-2">
              All sources activated
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {availableItems.map((source) => (
                <DraggableChip key={source} id={source} variant="available" onClick={handleChipClick} />
              ))}
            </div>
          )}
        </DroppableZone>
      </div>

      <DragOverlay>
        {draggedItem && <ChipOverlay id={draggedItem} />}
      </DragOverlay>
    </DndContext>
  );
}

function DroppableZone({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`border rounded-lg p-3 transition-colors ${
        isOver
          ? "border-cf-accent-blue bg-cf-accent-blue/5"
          : "border-cf-border bg-cf-bg-tertiary"
      }`}
    >
      <p className="text-xxs text-cf-text-muted font-semibold uppercase tracking-wider mb-2">
        {label}
      </p>
      {children}
    </div>
  );
}

function DraggableChip({
  id,
  variant,
  onClick,
}: {
  id: string;
  variant: "active" | "available";
  onClick?: (id: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const label = id.replace(/_/g, " ");

  // Click handler: only fire if the pointer didn't move (i.e. not a drag).
  // dnd-kit's PointerSensor has a distance threshold of 5px, so a stationary
  // click won't trigger drag and will reach onClick.
  const handleClick = () => {
    if (onClick) onClick(id);
  };

  return (
    <span
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      className={`inline-flex items-center px-2.5 py-1 rounded-full text-xxs font-medium cursor-pointer transition-colors ${
        isDragging ? "opacity-50" : ""
      } ${
        variant === "active"
          ? "bg-cf-accent-blue/15 text-cf-accent-blue border border-cf-accent-blue/30 hover:bg-cf-accent-blue/25"
          : "bg-cf-bg-secondary text-cf-text-secondary border border-cf-border hover:border-cf-text-muted hover:bg-cf-bg-tertiary"
      }`}
    >
      {label}
    </span>
  );
}

function ChipOverlay({ id }: { id: string }) {
  const label = id.replace(/_/g, " ");
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xxs font-medium bg-cf-accent-blue/20 text-cf-accent-blue border border-cf-accent-blue shadow-lg">
      {label}
    </span>
  );
}
